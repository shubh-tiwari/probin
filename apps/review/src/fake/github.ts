/**
 * A fake GitHub, for local development and tests. NOT part of the product.
 *
 * It serves the GitHub App API calls Review makes, for repositories loaded
 * from local folders, and plays the developers: /fake/* endpoints open a pull
 * request from a set of file changes, merge it, and report a deploy. Each
 * sends the webhook GitHub would, signed with the webhook secret.
 */
import { createHash, createHmac, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { serve } from '@hono/node-server';
import { structuredPatch } from 'diff';
import { Hono } from 'hono';

type Files = Map<string, string>;
interface RepoState {
  commits: Map<string, Files>;
  branches: Map<string, string>;
  pulls: Map<
    number,
    {
      number: number;
      title: string;
      base: string;
      head: string;
      merged: boolean;
      mergeSha: string | null;
    }
  >;
  comments: { id: number; pull: number; path?: string; line?: number; body: string }[];
}

const SKIP = new Set(['node_modules', '.venv', '__pycache__', 'dist', '.git']);
function readTree(root: string, base = root, out: Files = new Map()): Files {
  for (const name of readdirSync(root)) {
    if (SKIP.has(name) || name.endsWith('.lock') || name === 'package-lock.json') continue;
    const path = join(root, name);
    if (statSync(path).isDirectory()) readTree(path, base, out);
    else out.set(relative(base, path), readFileSync(path, 'utf8'));
  }
  return out;
}

const commitSha = (files: Files, parent: string) =>
  createHash('sha1')
    .update(parent)
    .update(JSON.stringify([...files].sort()))
    .digest('hex');

export function createFakeGitHub(options: {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  webhookUrl: string;
  /** Where the app's setup URL is (the web tool), for the install flow. */
  setupUrl: string;
  /** `owner/name` → { folder in the repo: local folder }. */
  repos: Record<string, Record<string, string>>;
}) {
  const publicKey = createPublicKey(options.privateKey);
  const repos = new Map<string, RepoState>();
  for (const [name, folders] of Object.entries(options.repos)) {
    const files: Files = new Map();
    for (const [prefix, folder] of Object.entries(folders)) {
      for (const [path, content] of readTree(folder)) files.set(`${prefix}/${path}`, content);
    }
    const sha = commitSha(files, '');
    repos.set(name, {
      commits: new Map([[sha, files]]),
      branches: new Map([['main', sha]]),
      pulls: new Map(),
      comments: [],
    });
  }
  const installations = new Map<string, string>();
  let nextComment = 1000;

  async function webhook(event: string, payload: object) {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', options.webhookSecret).update(body).digest('hex')}`;
    const response = await fetch(options.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': randomBytes(8).toString('hex'),
        'x-hub-signature-256': signature,
      },
      body,
    }).catch(() => undefined);
    return response?.status;
  }

  const app = new Hono();

  /** The app's JWT: RS256 with the app's private key, issued by the app. */
  app.post('/app/installations/:id/access_tokens', (c) => {
    const jwt = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    const [header, payload, signature] = jwt.split('.');
    const valid =
      header &&
      payload &&
      signature &&
      createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(publicKey, Buffer.from(signature, 'base64url')) &&
      JSON.parse(Buffer.from(payload, 'base64url').toString()).iss === options.appId;
    if (!valid) return c.json({ message: 'A JSON web token could not be decoded' }, 401);
    if (!installations.has(c.req.param('id'))) return c.json({ message: 'Not Found' }, 404);
    return c.json(
      {
        token: `ghs_fake_${c.req.param('id')}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
      201,
    );
  });

  // Every other API call needs an installation token.
  app.use('/repos/*', async (c, next) => {
    const id = /^Bearer ghs_fake_(\d+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    if (!id || !installations.has(id)) return c.json({ message: 'Bad credentials' }, 401);
    await next();
  });
  const repoOf = (c: { req: { param(n: string): string } }) =>
    repos.get(`${c.req.param('owner')}/${c.req.param('name')}`);

  app.get('/installation/repositories', (c) => {
    const id = /^Bearer ghs_fake_(\d+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    if (!id || !installations.has(id)) return c.json({ message: 'Bad credentials' }, 401);
    return c.json({
      total_count: repos.size,
      repositories: [...repos.keys()].map((full_name) => ({ full_name, default_branch: 'main' })),
    });
  });
  app.get('/repos/:owner/:name/branches/:branch', (c) => {
    const sha = repoOf(c)?.branches.get(c.req.param('branch'));
    return sha
      ? c.json({ name: c.req.param('branch'), commit: { sha } })
      : c.json({ message: 'Not Found' }, 404);
  });
  app.get('/repos/:owner/:name/git/trees/:sha', (c) => {
    const files = repoOf(c)?.commits.get(c.req.param('sha'));
    if (!files) return c.json({ message: 'Not Found' }, 404);
    return c.json({
      sha: c.req.param('sha'),
      tree: [...files.keys()].map((path) => ({ path, type: 'blob', mode: '100644' })),
      truncated: false,
    });
  });
  app.get('/repos/:owner/:name/contents/*', (c) => {
    const repo = repoOf(c);
    const path = decodeURIComponent(c.req.path.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ''));
    const files = repo?.commits.get(c.req.query('ref') ?? repo.branches.get('main')!);
    const content = files?.get(path);
    if (content === undefined) return c.json({ message: 'Not Found' }, 404);
    return c.json({
      path,
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(content).toString('base64'),
    });
  });
  app.get('/repos/:owner/:name/pulls/:number', (c) => {
    const pull = repoOf(c)?.pulls.get(Number(c.req.param('number')));
    if (!pull) return c.json({ message: 'Not Found' }, 404);
    return c.json({
      number: pull.number,
      title: pull.title,
      head: { sha: pull.head },
      base: { sha: pull.base },
      merged: pull.merged,
      merge_commit_sha: pull.mergeSha,
      html_url: `https://github.example/${c.req.param('owner')}/${c.req.param('name')}/pull/${pull.number}`,
    });
  });
  app.get('/repos/:owner/:name/pulls/:number/files', (c) => {
    const repo = repoOf(c);
    const pull = repo?.pulls.get(Number(c.req.param('number')));
    if (!repo || !pull) return c.json({ message: 'Not Found' }, 404);
    const before = repo.commits.get(pull.base)!;
    const after = repo.commits.get(pull.head)!;
    const paths = [...new Set([...before.keys(), ...after.keys()])].filter(
      (p) => before.get(p) !== after.get(p),
    );
    return c.json(
      paths.map((filename) => {
        const patch = structuredPatch(
          filename,
          filename,
          before.get(filename) ?? '',
          after.get(filename) ?? '',
          '',
          '',
          { context: 3 },
        );
        const text = patch.hunks
          .map(
            (h) =>
              `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`,
          )
          .join('\n');
        return {
          filename,
          status: !before.has(filename) ? 'added' : !after.has(filename) ? 'removed' : 'modified',
          patch: text,
        };
      }),
    );
  });
  app.get('/repos/:owner/:name/commits/:sha/pulls', (c) => {
    const repo = repoOf(c);
    const found = [...(repo?.pulls.values() ?? [])].filter(
      (p) => p.mergeSha === c.req.param('sha') || p.head === c.req.param('sha'),
    );
    return c.json(
      found.map((p) => ({
        number: p.number,
        title: p.title,
        head: { sha: p.head },
        base: { sha: p.base },
        merge_commit_sha: p.mergeSha,
        html_url: '',
      })),
    );
  });
  const addComment = async (
    c: {
      req: { param(n: string): string; json<T>(): Promise<T> };
      json: (v: unknown, s?: 201) => Response;
    },
    onLine: boolean,
  ) => {
    const repo = repoOf(c);
    const number = Number(c.req.param('number'));
    if (!repo?.pulls.has(number)) return c.json({ message: 'Not Found' });
    const body = await c.req.json<{ body: string; path?: string; line?: number }>();
    const comment = {
      id: nextComment++,
      pull: number,
      body: body.body,
      ...(onLine ? { path: body.path!, line: body.line! } : {}),
    };
    repo.comments.push(comment);
    return c.json({ ...comment, html_url: `https://github.example/comment/${comment.id}` }, 201);
  };
  app.post('/repos/:owner/:name/pulls/:number/comments', (c) => addComment(c as never, true));
  app.post('/repos/:owner/:name/issues/:number/comments', (c) => addComment(c as never, false));

  // ------------------------------------------------------------- developers

  /** Installing the app: approves at once and returns to the setup URL. */
  app.get('/fake/install', (c) => {
    const id = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
    installations.set(id, c.req.query('account') ?? 'acme');
    const back = new URL(options.setupUrl);
    back.searchParams.set('installation_id', id);
    back.searchParams.set('setup_action', 'install');
    back.searchParams.set('state', c.req.query('state') ?? '');
    return c.redirect(back.toString(), 302);
  });

  /** Open a pull request on `main` with some files changed (`null` deletes a file). */
  app.post('/fake/pulls', async (c) => {
    const input = await c.req.json<{
      repo: string;
      title: string;
      changes: Record<string, string | null>;
      installation: string;
    }>();
    const repo = repos.get(input.repo);
    if (!repo) return c.json({ error: 'no such repo' }, 404);
    const base = repo.branches.get('main')!;
    const files: Files = new Map(repo.commits.get(base)!);
    for (const [path, content] of Object.entries(input.changes)) {
      if (content === null) files.delete(path);
      else files.set(path, content);
    }
    const head = commitSha(files, base);
    repo.commits.set(head, files);
    const number = repo.pulls.size + 1;
    repo.pulls.set(number, {
      number,
      title: input.title,
      base,
      head,
      merged: false,
      mergeSha: null,
    });
    const status = await webhook('pull_request', {
      action: 'opened',
      number,
      installation: { id: Number(input.installation) },
      repository: { full_name: input.repo },
      pull_request: { number, title: input.title, head: { sha: head }, base: { sha: base } },
    });
    return c.json({ number, head, base, webhook: status });
  });

  /** Merge a pull request into main. */
  app.post('/fake/pulls/:number/merge', async (c) => {
    const input = await c.req.json<{ repo: string }>();
    const repo = repos.get(input.repo);
    const pull = repo?.pulls.get(Number(c.req.param('number')));
    if (!repo || !pull) return c.json({ error: 'no such pull request' }, 404);
    pull.merged = true;
    pull.mergeSha = pull.head;
    repo.branches.set('main', pull.head);
    return c.json({ sha: pull.head });
  });

  /** A successful deploy of a commit. */
  app.post('/fake/deployments', async (c) => {
    const input = await c.req.json<{
      repo: string;
      sha: string;
      installation: string;
      at?: number;
    }>();
    const status = await webhook('deployment_status', {
      action: 'created',
      installation: { id: Number(input.installation) },
      repository: { full_name: input.repo },
      deployment: { sha: input.sha, environment: 'production' },
      deployment_status: {
        state: 'success',
        created_at: new Date((input.at ?? Date.now() / 1000) * 1000).toISOString(),
      },
    });
    return c.json({ webhook: status });
  });

  /** The comments on a pull request, as people would see them. */
  app.get('/fake/comments', (c) => {
    const repo = repos.get(c.req.query('repo') ?? '');
    return c.json({
      comments: (repo?.comments ?? []).filter((m) => m.pull === Number(c.req.query('number'))),
    });
  });

  /** A file as it is on main, so a script can change it for a pull request. */
  app.get('/fake/file', (c) => {
    const repo = repos.get(c.req.query('repo') ?? '');
    const content = repo?.commits.get(repo.branches.get('main')!)?.get(c.req.query('path') ?? '');
    return content === undefined ? c.text('not found', 404) : c.text(content);
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  return { app };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const { app } = createFakeGitHub({
    appId: required('GITHUB_APP_ID'),
    privateKey: readFileSync(required('GITHUB_APP_PRIVATE_KEY_FILE'), 'utf8'),
    webhookSecret: required('GITHUB_WEBHOOK_SECRET'),
    webhookUrl: required('GITHUB_WEBHOOK_URL'),
    setupUrl: required('GITHUB_SETUP_URL'),
    repos: (() => {
      const root = process.env.DEMO_ROOT ?? 'infra/demo';
      return {
        'acme/shop': { checkout: `${root}/checkout-node`, inventory: `${root}/inventory-python` },
      };
    })(),
  });
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) });
  console.log('fake GitHub listening');
}
