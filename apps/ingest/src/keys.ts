import { createHash, randomBytes } from 'node:crypto';
import { PRODUCT_SLUG } from '@app/config';

/**
 * Ingestion keys. A key is shown once, when it is issued or rotated. Only its
 * SHA-256 hash is stored, which is enough because keys are long random
 * strings, not passwords.
 */

/** The prefix makes a leaked key recognisable in logs and secret scanners. */
const KEY_PREFIX = `${PRODUCT_SLUG}_ik_`;

export function generateIngestionKey(): string {
  return KEY_PREFIX + randomBytes(32).toString('base64url');
}

export function hashIngestionKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Read the key from an `Authorization: Bearer <key>` header. */
export function bearerKey(header: string | undefined | null): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match?.[1];
}
