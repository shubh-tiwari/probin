/**
 * A fake Slack, for local development and tests. NOT part of the product.
 *
 * It plays both sides of Slack:
 *   - the Web API the app calls (chat.*, files upload, users.info, oauth.v2.access),
 *     at /api/<method>, so the real app code runs against it unchanged;
 *   - the people: /fake/* endpoints that post a mention, a direct message or a
 *     button click to the app, signed with the signing secret exactly as Slack signs.
 *
 * Everything is kept in memory. GET /fake/thread shows a conversation.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

export interface FakeMessage {
  ts: string;
  thread_ts?: string;
  channel: string;
  /** Who posted: a person's id, or the bot. */
  user: string;
  text: string;
  blocks?: unknown[];
  /** Images attached to this message. */
  files?: { id: string; title: string; url: string; bytes: number }[];
  edited?: boolean;
  /** For ephemeral messages: the only person who sees it. */
  visibleTo?: string;
  postedAt: number;
}

export interface FakeSlackOptions {
  signingSecret: string;
  clientId: string;
  clientSecret: string;
  /** Where the Slack app listens, for events and clicks. */
  appUrl: string;
  /** This fake as the app reaches it (upload URLs). */
  internalUrl: string;
  /** This fake as people reach it (image links). */
  publicUrl: string;
}

export const BOT_USER = 'U0BOT';
/** People the fake knows by name. Anyone else is shown by id. */
const PEOPLE: Record<string, string> = { U0ALICE: 'Alice', U0BOB: 'Bob', U0CAROL: 'Carol' };
/** The Slack team `make dev` links to the dev workspace. */
export const DEV_TEAM = 'T0DEV';

export function createFakeSlack(options: FakeSlackOptions) {
  const messages: FakeMessage[] = [];
  const files = new Map<string, { title: string; data: Buffer; done: boolean }>();
  const codes = new Map<string, { team: string; name: string; user: string }>();
  let clock = Math.floor(Date.now() / 1000);
  let counter = 0;
  const nextTs = () => {
    const now = Math.floor(Date.now() / 1000);
    clock = Math.max(clock, now);
    counter += 1;
    return `${clock}.${String(counter).padStart(6, '0')}`;
  };
  const tokenTeam = (header: string | undefined) =>
    /^Bearer xoxb-fake-(\w+)$/.exec(header ?? '')?.[1];

  const app = new Hono();

  /** Read a Web API call's arguments, form-encoded or JSON. */
  const args = async (c: {
    req: {
      header(n: string): string | undefined;
      parseBody(): Promise<Record<string, unknown>>;
      json(): Promise<unknown>;
    };
  }) => {
    const type = c.req.header('content-type') ?? '';
    const raw = type.includes('json')
      ? ((await c.req.json()) as Record<string, unknown>)
      : await c.req.parseBody();
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string' && /^[[{]/.test(value)) {
        try {
          out[key] = JSON.parse(value);
          continue;
        } catch {
          // a plain string after all
        }
      }
      out[key] = value;
    }
    return out;
  };

  app.post('/api/:method', async (c) => {
    const method = c.req.param('method');
    const a = await args(c);
    const team =
      tokenTeam(c.req.header('authorization')) ??
      (typeof a.token === 'string' ? /xoxb-fake-(\w+)/.exec(a.token)?.[1] : undefined);
    const needsToken = ![
      'oauth.v2.access',
      'openid.connect.token',
      'openid.connect.userInfo',
    ].includes(method);
    if (needsToken && !team) return c.json({ ok: false, error: 'invalid_auth' });

    switch (method) {
      case 'openid.connect.token': {
        if (a.client_id !== options.clientId || a.client_secret !== options.clientSecret) {
          return c.json({ ok: false, error: 'invalid_client' });
        }
        const grant = codes.get(String(a.code));
        if (!grant) return c.json({ ok: false, error: 'invalid_code' });
        codes.delete(String(a.code));
        const token = `xoxp-fake-${grant.team}-${grant.user}`;
        return c.json({ ok: true, access_token: token, token_type: 'Bearer', id_token: 'fake' });
      }
      case 'openid.connect.userInfo': {
        const match = /^Bearer xoxp-fake-(\w+)-(\w+)$/.exec(c.req.header('authorization') ?? '');
        if (!match) return c.json({ ok: false, error: 'invalid_auth' });
        const [, teamId, userId] = match;
        return c.json({
          ok: true,
          sub: userId,
          'https://slack.com/user_id': userId,
          'https://slack.com/team_id': teamId,
          name: PEOPLE[userId!] ?? userId,
        });
      }
      case 'auth.test':
        return c.json({ ok: true, team_id: team, user_id: BOT_USER, bot_id: 'B0BOT', team: team });
      case 'oauth.v2.access': {
        if (a.client_id !== options.clientId || a.client_secret !== options.clientSecret) {
          return c.json({ ok: false, error: 'invalid_client' });
        }
        const grant = codes.get(String(a.code));
        if (!grant) return c.json({ ok: false, error: 'invalid_code' });
        codes.delete(String(a.code));
        return c.json({
          ok: true,
          access_token: `xoxb-fake-${grant.team}`,
          token_type: 'bot',
          bot_user_id: BOT_USER,
          team: { id: grant.team, name: grant.name },
          authed_user: { id: grant.user },
        });
      }
      case 'chat.postMessage': {
        const message: FakeMessage = {
          ts: nextTs(),
          channel: String(a.channel),
          user: BOT_USER,
          text: String(a.text ?? ''),
          postedAt: Date.now(),
          ...(a.thread_ts ? { thread_ts: String(a.thread_ts) } : {}),
          ...(Array.isArray(a.blocks) ? { blocks: a.blocks } : {}),
        };
        messages.push(message);
        return c.json({ ok: true, channel: message.channel, ts: message.ts, message });
      }
      case 'chat.update': {
        const message = messages.find((m) => m.ts === a.ts && m.channel === a.channel);
        if (!message) return c.json({ ok: false, error: 'message_not_found' });
        message.text = String(a.text ?? message.text);
        if (Array.isArray(a.blocks)) message.blocks = a.blocks;
        message.edited = true;
        return c.json({ ok: true, ts: message.ts, channel: message.channel });
      }
      case 'chat.postEphemeral': {
        messages.push({
          ts: nextTs(),
          channel: String(a.channel),
          user: BOT_USER,
          text: String(a.text ?? ''),
          visibleTo: String(a.user),
          postedAt: Date.now(),
          ...(a.thread_ts ? { thread_ts: String(a.thread_ts) } : {}),
        });
        return c.json({ ok: true, message_ts: messages.at(-1)!.ts });
      }
      case 'users.info': {
        const id = String(a.user);
        const name = PEOPLE[id] ?? id;
        return c.json({
          ok: true,
          user: { id, name: name.toLowerCase(), real_name: name, profile: { display_name: name } },
        });
      }
      case 'files.getUploadURLExternal': {
        const id = `F${randomBytes(5).toString('hex').toUpperCase()}`;
        files.set(id, { title: String(a.filename ?? ''), data: Buffer.alloc(0), done: false });
        return c.json({ ok: true, file_id: id, upload_url: `${options.internalUrl}/upload/${id}` });
      }
      case 'files.completeUploadExternal': {
        const list = (a.files as { id: string; title?: string }[]) ?? [];
        const attached = list.map((entry) => {
          const file = files.get(entry.id);
          if (!file) throw new Error(`unknown file ${entry.id}`);
          file.done = true;
          if (entry.title) file.title = entry.title;
          return {
            id: entry.id,
            title: file.title,
            url: `${options.publicUrl}/fake/files/${entry.id}`,
            bytes: file.data.length,
          };
        });
        messages.push({
          ts: nextTs(),
          channel: String(a.channel_id),
          user: BOT_USER,
          text: String(a.initial_comment ?? ''),
          files: attached,
          postedAt: Date.now(),
          ...(a.thread_ts ? { thread_ts: String(a.thread_ts) } : {}),
        });
        return c.json({ ok: true, files: attached.map((f) => ({ id: f.id, title: f.title })) });
      }
      default:
        return c.json({ ok: false, error: 'unknown_method' });
    }
  });

  app.post('/upload/:id', async (c) => {
    const file = files.get(c.req.param('id'));
    if (!file) return c.text('no such upload', 404);
    const type = c.req.header('content-type') ?? '';
    if (type.includes('multipart/form-data')) {
      const form = await c.req.parseBody();
      const blob = Object.values(form).find((value): value is File => value instanceof Blob);
      file.data = blob ? Buffer.from(await blob.arrayBuffer()) : Buffer.alloc(0);
    } else {
      file.data = Buffer.from(await c.req.arrayBuffer());
    }
    return c.text(`OK - ${file.data.length}`);
  });

  // ------------------------------------------------------------------ people

  /** The install page a person approves: approves at once and goes back to the app. */
  app.get('/oauth/v2/authorize', (c) => {
    const redirect = c.req.query('redirect_uri');
    if (c.req.query('client_id') !== options.clientId || !redirect)
      return c.text('bad request', 400);
    const team = c.req.query('team') ?? `T0${randomBytes(4).toString('hex').toUpperCase()}`;
    const code = randomBytes(12).toString('hex');
    codes.set(code, {
      team,
      name: c.req.query('team_name') ?? `Team ${team}`,
      user: c.req.query('user') ?? 'U0ALICE',
    });
    const back = new URL(redirect);
    back.searchParams.set('code', code);
    back.searchParams.set('state', c.req.query('state') ?? '');
    return c.redirect(back.toString(), 302);
  });

  /** Sign in with Slack: approves at once as the person and team given (Alice in the dev team by default). */
  app.get('/openid/connect/authorize', (c) => {
    const redirect = c.req.query('redirect_uri');
    if (c.req.query('client_id') !== options.clientId || !redirect)
      return c.text('bad request', 400);
    const code = randomBytes(12).toString('hex');
    codes.set(code, {
      team: c.req.query('team') ?? DEV_TEAM,
      name: '',
      user: c.req.query('user') ?? 'U0ALICE',
    });
    const back = new URL(redirect);
    back.searchParams.set('code', code);
    back.searchParams.set('state', c.req.query('state') ?? '');
    return c.redirect(back.toString(), 302);
  });

  /** Send something to the app, signed like Slack signs it. */
  async function deliver(body: string, contentType: string) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac('sha256', options.signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
    const response = await fetch(`${options.appUrl}/slack/events`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      body,
    });
    return response.status;
  }

  const eventEnvelope = (team: string, event: Record<string, unknown>) =>
    JSON.stringify({
      token: 'fake',
      team_id: team,
      api_app_id: 'A0FAKE',
      type: 'event_callback',
      event_id: `Ev${randomBytes(6).toString('hex')}`,
      event_time: Math.floor(Date.now() / 1000),
      authorizations: [{ team_id: team, user_id: BOT_USER, is_bot: true }],
      event,
    });

  /** A person mentions the bot in a channel. */
  app.post('/fake/mention', async (c) => {
    const {
      team = DEV_TEAM,
      user = 'U0ALICE',
      channel = 'C0OPS',
      text,
      thread_ts,
    } = await c.req.json<{
      team?: string;
      user?: string;
      channel?: string;
      text: string;
      thread_ts?: string;
    }>();
    const ts = nextTs();
    const fullText = `<@${BOT_USER}> ${text}`;
    messages.push({
      ts,
      channel,
      user,
      text: fullText,
      postedAt: Date.now(),
      ...(thread_ts ? { thread_ts } : {}),
    });
    const status = await deliver(
      eventEnvelope(team, {
        type: 'app_mention',
        user,
        text: fullText,
        ts,
        channel,
        event_ts: ts,
        ...(thread_ts ? { thread_ts } : {}),
      }),
      'application/json',
    );
    return c.json({ ts, channel, status });
  });

  /** A person sends the bot a direct message. */
  app.post('/fake/dm', async (c) => {
    const {
      team = DEV_TEAM,
      user = 'U0ALICE',
      text,
    } = await c.req.json<{ team?: string; user?: string; text: string }>();
    const channel = `D0${user}`;
    const ts = nextTs();
    messages.push({ ts, channel, user, text, postedAt: Date.now() });
    const status = await deliver(
      eventEnvelope(team, {
        type: 'message',
        channel_type: 'im',
        user,
        text,
        ts,
        channel,
        event_ts: ts,
      }),
      'application/json',
    );
    return c.json({ ts, channel, status });
  });

  /**
   * A person clicks a button or picks from a menu in a message.
   * Give `action_id` (or `label`, the button's text) and, for a menu, `option` (its value or text).
   */
  app.post('/fake/click', async (c) => {
    const input = await c.req.json<{
      team?: string;
      user?: string;
      channel?: string;
      message_ts: string;
      action_id?: string;
      label?: string;
      option?: string;
    }>();
    const message = messages.find(
      (m) => m.ts === input.message_ts && (!input.channel || m.channel === input.channel),
    );
    if (!message?.blocks) return c.json({ error: 'no such message with blocks' }, 404);
    type Element = {
      type: string;
      action_id: string;
      value?: string;
      url?: string;
      text?: { text: string };
      options?: { value: string; text: { text: string } }[];
    };
    const found = (message.blocks as { type: string; block_id?: string; elements?: Element[] }[])
      .filter((block) => block.type === 'actions')
      .flatMap((block) => (block.elements ?? []).map((element) => ({ block, element })))
      .find(({ element }) =>
        input.action_id
          ? element.action_id === input.action_id
          : element.text?.text === input.label,
      );
    if (!found) return c.json({ error: 'no such button or menu' }, 404);
    const { block, element } = found;
    let action: Record<string, unknown> = {
      type: element.type,
      action_id: element.action_id,
      block_id: block.block_id,
      action_ts: nextTs(),
      ...(element.value !== undefined ? { value: element.value } : {}),
      ...(element.text ? { text: { type: 'plain_text', text: element.text.text } } : {}),
    };
    if (element.type === 'static_select') {
      const option = element.options?.find(
        (o) =>
          o.value === input.option ||
          o.text.text === input.option ||
          o.text.text.startsWith(`${input.option} ·`),
      );
      if (!option) return c.json({ error: `no option ${input.option}` }, 404);
      action = {
        ...action,
        selected_option: {
          value: option.value,
          text: { type: 'plain_text', text: option.text.text },
        },
      };
    }
    const team = input.team ?? DEV_TEAM;
    const user = input.user ?? 'U0ALICE';
    const payload = {
      type: 'block_actions',
      team: { id: team, domain: 'fake' },
      user: { id: user, team_id: team, name: PEOPLE[user]?.toLowerCase() ?? user },
      api_app_id: 'A0FAKE',
      token: 'fake',
      trigger_id: randomBytes(6).toString('hex'),
      channel: { id: message.channel, name: message.channel },
      container: {
        type: 'message',
        message_ts: message.ts,
        channel_id: message.channel,
        is_ephemeral: false,
        ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
      },
      message: {
        type: 'message',
        ts: message.ts,
        text: message.text,
        blocks: message.blocks,
        ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
      },
      actions: [action],
      response_url: `${options.internalUrl}/fake/response`,
    };
    const status = await deliver(
      `payload=${encodeURIComponent(JSON.stringify(payload))}`,
      'application/x-www-form-urlencoded',
    );
    return c.json({ status });
  });

  /** A thread as people would see it, oldest first. `user` hides others' ephemeral messages. */
  app.get('/fake/thread', (c) => {
    const channel = c.req.query('channel');
    const thread = c.req.query('thread_ts');
    const viewer = c.req.query('user');
    return c.json({
      messages: messages.filter(
        (m) =>
          m.channel === channel &&
          (m.ts === thread || m.thread_ts === thread) &&
          (!m.visibleTo || !viewer || m.visibleTo === viewer),
      ),
    });
  });

  /** Every message in a channel, top level and threads. */
  app.get('/fake/channel', (c) => {
    const channel = c.req.query('channel');
    return c.json({ messages: messages.filter((m) => m.channel === channel && !m.visibleTo) });
  });

  app.get('/fake/files/:id', (c) => {
    const file = files.get(c.req.param('id'));
    if (!file?.done) return c.text('no such file', 404);
    return new Response(file.data, { headers: { 'content-type': 'image/png' } });
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  return { app, messages };
}

// Run as a service.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const port = Number(process.env.PORT ?? 8080);
  const { app } = createFakeSlack({
    signingSecret: required('SLACK_SIGNING_SECRET'),
    clientId: required('SLACK_CLIENT_ID'),
    clientSecret: required('SLACK_CLIENT_SECRET'),
    appUrl: required('SLACK_APP_URL'),
    internalUrl: required('FAKE_INTERNAL_URL'),
    publicUrl: required('FAKE_PUBLIC_URL'),
  });
  serve({ fetch: app.fetch, port });
  console.log(`fake Slack listening on :${port}`);
}
