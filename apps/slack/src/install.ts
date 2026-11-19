import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PRODUCT_NAME, PRODUCT_SLUG, type PlansConfig } from '@app/config';
import { createWorkspace, type Database } from '@app/db';
import { generateIngestionKey, hashIngestionKey } from '@app/ingest';
import { WebClient } from '@slack/web-api';
import type { SlackStore } from './store.js';

/** What the bot needs: mentions, direct messages, posting, files, and people's names. */
export const BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'groups:history',
  'im:history',
  'im:read',
  'im:write',
  'chat:write',
  'files:write',
  'users:read',
];

export interface InstallOptions {
  db: Database;
  store: SlackStore;
  plans: PlansConfig;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  apiUrl: string;
  publicUrl: string;
  ingestUrl: string;
  webUrl: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

/** A signed, expiring state value, so a callback can only answer an install we started. */
function makeState(secret: string): string {
  const body = `${randomBytes(12).toString('base64url')}.${Date.now() + STATE_TTL_MS}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function checkState(state: string, secret: string, now = Date.now()): boolean {
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
  const given = Buffer.from(parts[2]!);
  return (
    given.length === expected.length && timingSafeEqual(given, expected) && Number(parts[1]) > now
  );
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1f2328}code{background:#f3f4f6;padding:.1rem .3rem;border-radius:4px;word-break:break-all}</style></head><body>${body}</body></html>`;

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The install flow, which is also sign-up: the first install from a Slack
 * workspace creates a product workspace, its first admin, and its ingestion
 * key (shown once). A later install from the same Slack workspace refreshes
 * the bot token and keeps everything else.
 */
export function installRoutes(options: InstallOptions) {
  const redirectUri = `${options.publicUrl}/slack/oauth/callback`;
  const send = (res: ServerResponse, status: number, html: string) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(html);
  };

  return [
    {
      path: '/slack/install',
      method: ['GET'],
      handler: (_req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(options.authorizeUrl);
        url.searchParams.set('client_id', options.clientId);
        url.searchParams.set('scope', BOT_SCOPES.join(','));
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('state', makeState(options.clientSecret));
        res.writeHead(302, { location: url.toString() });
        res.end();
      },
    },
    {
      path: '/slack/oauth/callback',
      method: ['GET'],
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const params = new URL(req.url ?? '', 'http://local').searchParams;
        const code = params.get('code');
        if (params.get('error')) {
          send(
            res,
            200,
            page('Install cancelled', '<h1>Install cancelled</h1><p>Nothing was changed.</p>'),
          );
          return;
        }
        if (!code || !checkState(params.get('state') ?? '', options.clientSecret)) {
          send(
            res,
            400,
            page(
              'Install failed',
              '<h1>Install failed</h1><p>The link has expired. Start the install again.</p>',
            ),
          );
          return;
        }
        try {
          const client = new WebClient(undefined, { slackApiUrl: `${options.apiUrl}/` });
          const access = await client.oauth.v2.access({
            client_id: options.clientId,
            client_secret: options.clientSecret,
            code,
            redirect_uri: redirectUri,
          });
          const team = access.team as { id: string; name: string } | undefined;
          const botToken = access.access_token;
          const botUserId = access.bot_user_id;
          const installer = (access.authed_user as { id?: string } | undefined)?.id;
          if (!team?.id || !botToken || !botUserId)
            throw new Error('Slack returned an incomplete install.');

          const existing = await options.store.installationForTeam(team.id);
          if (existing) {
            await options.store.saveInstallation(
              { ...existing, teamName: team.name, botUserId, botToken },
              null,
            );
            send(
              res,
              200,
              page(
                `${PRODUCT_NAME} reinstalled`,
                `<h1>${PRODUCT_NAME} is reinstalled in ${escapeHtml(team.name)}</h1><p>Your dashboards, alerts and ingestion key are unchanged.</p>`,
              ),
            );
            return;
          }

          // A new customer: workspace, first admin, ingestion key.
          const key = generateIngestionKey();
          const workspace = await createWorkspace(options.db, {
            name: team.name,
            plan: options.plans.trial.plan,
            ingestionKeyHash: hashIngestionKey(key),
            trialEndsAt: new Date(Date.now() + options.plans.trial.days * 86_400_000),
          });
          const adminId = installer
            ? await options.store.ensureUser(
                workspace.id,
                installer,
                async () => installer,
                'admin',
              )
            : null;
          await options.store.saveInstallation(
            {
              workspaceId: workspace.id,
              teamId: team.id,
              teamName: team.name,
              botUserId,
              botToken,
            },
            adminId,
          );
          send(
            res,
            200,
            page(
              `${PRODUCT_NAME} installed`,
              `<h1>${PRODUCT_NAME} is installed in ${escapeHtml(team.name)}</h1>
<p>Mention <strong>@${PRODUCT_SLUG}</strong> in a channel, or send it a direct message, to ask for a chart.</p>
<h2>Send metrics</h2>
<p>Install the ${PRODUCT_NAME} skill in Claude Code and give your services these settings.</p>
<p>Ingestion URL: <code>${escapeHtml(options.ingestUrl)}</code></p>
<p>Ingestion key: <code>${escapeHtml(key)}</code></p>
<p><strong>This key is shown once.</strong> Keep it in your secret store, never in a repository. An admin can rotate it later.</p>
<p><a href="${escapeHtml(options.webUrl)}">Open the web tool</a></p>`,
            ),
          );
        } catch (error) {
          console.error('install failed', error);
          send(
            res,
            502,
            page(
              'Install failed',
              '<h1>Install failed</h1><p>Slack did not complete the install. Try again.</p>',
            ),
          );
        }
      },
    },
  ];
}
