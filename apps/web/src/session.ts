import { createHmac, timingSafeEqual } from 'node:crypto';

/** Who is signed in. Kept in a signed cookie; nothing about it is stored on the server. */
export interface Session {
  userId: string;
  workspaceId: string;
  name: string;
  /** Unix seconds. */
  expires: number;
}

export const SESSION_COOKIE = 'session';
export const SESSION_DAYS = 14;

/** A key for sessions only, derived from SECRETS_KEY, so the two are never interchangeable. */
export function sessionKey(secretsKey: string): Buffer {
  return createHmac('sha256', Buffer.from(secretsKey, 'base64')).update('web session v1').digest();
}

export function sealSession(session: Session, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

export function openSession(
  value: string | undefined,
  key: Buffer,
  now = Date.now(),
): Session | undefined {
  if (!value) return undefined;
  const [body, signature] = value.split('.');
  if (!body || !signature) return undefined;
  const expected = Buffer.from(createHmac('sha256', key).update(body).digest('base64url'));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const session = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Session;
    return session.expires * 1000 > now ? session : undefined;
  } catch {
    return undefined;
  }
}
