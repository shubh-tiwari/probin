import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts secrets kept in the database, such as Slack bot tokens, with
 * AES-256-GCM. The key comes from SECRETS_KEY and never touches the database.
 * The stored form is `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 */
export function createSecretBox(keyBase64: string) {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64-encoded.');
  return {
    seal(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v1', iv, cipher.getAuthTag(), body]
        .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
        .join('.');
    },
    open(sealed: string): string {
      const [version, iv, tag, body] = sealed.split('.');
      if (version !== 'v1' || !iv || !tag || body === undefined)
        throw new Error('Not a sealed secret.');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

export type SecretBox = ReturnType<typeof createSecretBox>;
