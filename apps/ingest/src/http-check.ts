import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * One HTTP check, as a collector runs it: GET the URL, record whether it
 * answered 2xx or 3xx and how long it took.
 *
 * The URL comes from a customer's request, so the check must not be usable to
 * reach our own network. It refuses non-HTTP URLs and any host that resolves
 * to a private, loopback or link-local address, and it does not follow
 * redirects. `allowPrivate` lifts the address check for local development,
 * where the demo services are on a private network.
 */
export interface CheckResult {
  ok: boolean;
  status: number | null;
  /** Seconds. */
  duration: number;
  error?: string;
}

export class UnsafeUrlError extends Error {
  override name = 'UnsafeUrlError';
}

/** Never fetched, in any environment: this machine, link-local (cloud metadata lives here), unspecified, multicast. */
const ALWAYS_BLOCKED_V4: [number, number][] = [
  [0x7f000000, 8], [0xa9fe0000, 16], [0x00000000, 8], [0xe0000000, 4], [0xf0000000, 4],
]; // prettier-ignore
/** Private networks: refused in production, allowed in local development where the demo services live. */
const PRIVATE_V4: [number, number][] = [
  [0x0a000000, 8], [0xac100000, 12], [0xc0a80000, 16], [0x64400000, 10],
]; // prettier-ignore

const inRanges = (address: string, ranges: [number, number][]) => {
  const value = address.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
  return ranges.some(([base, bits]) => value >>> (32 - bits) === base >>> (32 - bits));
};

/** Loopback, link-local, unspecified or multicast: never a collector's target. */
export function isAlwaysBlocked(address: string): boolean {
  if (isIP(address) === 4) return inRanges(address, ALWAYS_BLOCKED_V4);
  const v6 = address.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('::ffff:')) return isAlwaysBlocked(v6.slice(7));
  return /^(fe8|fe9|fea|feb|ff)/.test(v6);
}

/** Any address that is not on the public internet. */
export function isPrivateAddress(address: string): boolean {
  if (isAlwaysBlocked(address)) return true;
  if (isIP(address) === 4) return inRanges(address, PRIVATE_V4);
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return /^(fc|fd)/.test(v6);
}

/** Refuse a URL a collector must not fetch. Resolves the host name to check where it points. */
export async function assertSafeUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('That is not a URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new UnsafeUrlError('Only http and https URLs can be monitored.');
  if (url.username || url.password)
    throw new UnsafeUrlError('URLs with credentials in them cannot be monitored.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new UnsafeUrlError(`${url.hostname} does not resolve.`);
  // `allowPrivate` opens ordinary private networks, never this machine or link-local (cloud metadata).
  const refused = allowPrivate ? addresses.some(isAlwaysBlocked) : addresses.some(isPrivateAddress);
  if (refused) throw new UnsafeUrlError(`${url.hostname} points to a private network address.`);
  return url;
}

export async function runHttpCheck(
  raw: string,
  options: { allowPrivate: boolean; timeoutMs?: number },
): Promise<CheckResult> {
  const url = await assertSafeUrl(raw, options.allowPrivate);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      headers: { 'user-agent': 'uptime-check' },
    });
    await response.body?.cancel();
    const duration = (performance.now() - started) / 1000;
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      duration,
    };
  } catch (error) {
    const duration = (performance.now() - started) / 1000;
    const timeout = error instanceof Error && error.name === 'TimeoutError';
    return {
      ok: false,
      status: null,
      duration,
      error: timeout ? 'timed out' : 'could not connect',
    };
  }
}
