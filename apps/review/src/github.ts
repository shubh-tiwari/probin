import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

/**
 * The GitHub App client: only the calls Review makes. Repository access is
 * read-only except for comments; Review never pushes commits.
 */
export interface GitHubOptions {
  apiUrl: string;
  appId: string;
  /** The app's private key, PEM. A secret. */
  privateKey: string;
  fetch?: typeof fetch;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** The app's own JWT, valid for nine minutes, signed RS256 with its private key. */
export function appJwt(
  appId: string,
  privateKey: string,
  now = Math.floor(Date.now() / 1000),
): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Check a webhook's `X-Hub-Signature-256` against its raw body. */
export function verifyWebhook(
  body: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  patch?: string;
}

export interface Pull {
  number: number;
  title: string;
  head: { sha: string };
  base: { sha: string };
  merge_commit_sha: string | null;
  html_url: string;
}

export function createGitHub(options: GitHubOptions) {
  const doFetch = options.fetch ?? fetch;
  const tokens = new Map<string, { token: string; until: number }>();

  async function installationToken(installationId: string): Promise<string> {
    const cached = tokens.get(installationId);
    if (cached && cached.until > Date.now()) return cached.token;
    const response = await doFetch(
      `${options.apiUrl}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${appJwt(options.appId, options.privateKey)}`,
          accept: 'application/vnd.github+json',
        },
      },
    );
    if (!response.ok)
      throw new Error(`GitHub refused an installation token: HTTP ${response.status}`);
    const body = (await response.json()) as { token: string };
    tokens.set(installationId, { token: body.token, until: Date.now() + 50 * 60_000 });
    return body.token;
  }

  function forInstallation(installationId: string) {
    async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
      const response = await doFetch(`${options.apiUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${await installationToken(installationId)}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
      if (!response.ok)
        throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: HTTP ${response.status}`);
      return (await response.json()) as T;
    }
    return {
      repositories: async () =>
        (
          await call<{ repositories: { full_name: string; default_branch: string }[] }>(
            '/installation/repositories',
          )
        ).repositories,
      branchHead: async (repo: string, branch: string) =>
        (
          await call<{ commit: { sha: string } }>(
            `/repos/${repo}/branches/${encodeURIComponent(branch)}`,
          )
        ).commit.sha,
      tree: async (repo: string, sha: string) =>
        (
          await call<{ tree: { path: string; type: string }[] }>(
            `/repos/${repo}/git/trees/${sha}?recursive=1`,
          )
        ).tree
          .filter((entry) => entry.type === 'blob')
          .map((entry) => entry.path),
      file: async (repo: string, path: string, ref: string) => {
        const body = await call<{ content: string; encoding: string }>(
          `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`,
        );
        return Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8').toString(
          'utf8',
        );
      },
      pull: (repo: string, number: number) => call<Pull>(`/repos/${repo}/pulls/${number}`),
      pullFiles: (repo: string, number: number) =>
        call<PullFile[]>(`/repos/${repo}/pulls/${number}/files?per_page=100`),
      pullsForCommit: (repo: string, sha: string) =>
        call<Pull[]>(`/repos/${repo}/commits/${sha}/pulls`),
      /** A comment on one line of a pull request's diff. */
      lineComment: (
        repo: string,
        number: number,
        input: { body: string; commit_id: string; path: string; line: number },
      ) =>
        call<{ id: number; html_url: string }>(`/repos/${repo}/pulls/${number}/comments`, {
          method: 'POST',
          body: JSON.stringify({ ...input, side: 'RIGHT' }),
        }),
      /** A comment on the pull request as a whole. */
      comment: (repo: string, number: number, body: string) =>
        call<{ id: number; html_url: string }>(`/repos/${repo}/issues/${number}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        }),
    };
  }

  return { forInstallation };
}

export type GitHub = ReturnType<typeof createGitHub>;
export type Repo = ReturnType<GitHub['forInstallation']>;
