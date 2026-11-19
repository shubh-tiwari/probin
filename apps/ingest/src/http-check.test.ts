import { describe, expect, it } from 'vitest';
import { UnsafeUrlError, assertSafeUrl, isPrivateAddress } from './http-check.js';

describe('collector URL safety', () => {
  it.each([
    '10.0.0.5',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.3.4',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('%s is private', (address) => expect(isPrivateAddress(address)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111'])('%s is public', (address) =>
    expect(isPrivateAddress(address)).toBe(false),
  );

  it.each([
    'http://127.0.0.1/health',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]:8080/',
    'http://localhost/health',
    'file:///etc/passwd',
    'gopher://example.com',
    'http://user:pass@example.com/',
    'not a url',
  ])('refuses %s', async (url) => {
    await expect(assertSafeUrl(url, false)).rejects.toThrow(UnsafeUrlError);
  });

  it('allows ordinary private networks only when told to (local development)', async () => {
    await expect(assertSafeUrl('http://10.1.2.3:8080/health', true)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl('http://10.1.2.3:8080/health', false)).rejects.toThrow(
      UnsafeUrlError,
    );
  });

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://127.0.0.1:5432/',
    'http://localhost/',
    'http://[::1]/',
    'http://0.0.0.0/',
  ])('refuses %s even in local development', async (url) => {
    await expect(assertSafeUrl(url, true)).rejects.toThrow(UnsafeUrlError);
  });
});
