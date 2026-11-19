import { randomBytes } from 'node:crypto';
import type { SlackStore } from '@app/slack';
import { WebClient } from '@slack/web-api';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { SESSION_COOKIE, SESSION_DAYS, sealSession } from './session.js';

export interface AuthOptions {
  store: SlackStore;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
  authorizeUrl: string;
  webUrl: string;
  sessionKey: Buffer;
}

const STATE_COOKIE = 'signin_state';

/**
 * Sign in with Slack (OpenID Connect). A person may sign in only to a
 * workspace whose Slack team has installed the app; they become a member of
 * it the first time.
 */
export function mountAuth(
  app: Hono,
  options: AuthOptions,
  renderMessage: (c: Context, title: string, text: string, status: 400 | 403) => Response,
) {
  const redirectUri = `${options.webUrl}/auth/slack/callback`;
  const secure = options.webUrl.startsWith('https://');

  app.get('/auth/slack', (c) => {
    const state = randomBytes(16).toString('base64url');
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'Lax',
      secure,
      path: '/auth',
      maxAge: 600,
    });
    const url = new URL(options.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid profile');
    url.searchParams.set('client_id', options.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', randomBytes(12).toString('base64url'));
    return c.redirect(url.toString(), 302);
  });

  app.get('/auth/slack/callback', async (c) => {
    const expected = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: '/auth' });
    const code = c.req.query('code');
    if (!code || !expected || c.req.query('state') !== expected) {
      return renderMessage(c, 'Sign-in failed', 'The sign-in link has expired. Try again.', 400);
    }
    const slack = new WebClient(undefined, { slackApiUrl: `${options.apiUrl}/` });
    let teamId: string | undefined;
    let slackUserId: string | undefined;
    let name = '';
    try {
      const token = await slack.openid.connect.token({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code,
        redirect_uri: redirectUri,
      });
      const info = (await new WebClient(token.access_token, {
        slackApiUrl: `${options.apiUrl}/`,
      }).openid.connect.userInfo()) as unknown as Record<string, unknown>;
      teamId = info['https://slack.com/team_id'] as string | undefined;
      slackUserId = info['https://slack.com/user_id'] as string | undefined;
      name = String(info.name ?? slackUserId ?? '');
    } catch (error) {
      console.error('sign-in failed', error);
    }
    if (!teamId || !slackUserId) {
      return renderMessage(
        c,
        'Sign-in failed',
        'Slack did not complete the sign-in. Try again.',
        400,
      );
    }
    const installation = await options.store.installationForTeam(teamId);
    if (!installation) {
      return renderMessage(
        c,
        'Not installed',
        'Your Slack workspace has not installed the app yet. An admin can install it from Slack first.',
        403,
      );
    }
    const userId = await options.store.ensureUser(
      installation.workspaceId,
      slackUserId,
      async () => name,
    );
    const expires = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400;
    setCookie(
      c,
      SESSION_COOKIE,
      sealSession(
        { userId, workspaceId: installation.workspaceId, name, expires },
        options.sessionKey,
      ),
      {
        httpOnly: true,
        sameSite: 'Lax',
        secure,
        path: '/',
        maxAge: SESSION_DAYS * 86_400,
      },
    );
    return c.redirect('/', 302);
  });

  app.post('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/login', 303);
  });
}
