/** A minimal browser for acceptance scripts: follows redirects by hand and keeps cookies. */
export function browser(base: string) {
  const cookies = new Map<string, string>();
  const keep = (response: Response) => {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, ...value] = pair!.split('=');
      if (/max-age=0|expires=Thu, 01 Jan 1970/i.test(header)) cookies.delete(name!.trim());
      else cookies.set(name!.trim(), value.join('='));
    }
  };
  const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');

  async function request(
    url: string,
    init: RequestInit = {},
    follow = true,
  ): Promise<{ status: number; url: string; html: string; location?: string }> {
    let current = new URL(url, base).toString();
    let method = init.method ?? 'GET';
    let body = init.body;
    for (let hop = 0; hop < 10; hop += 1) {
      const sameSite = current.startsWith(base);
      const response = await fetch(current, {
        method,
        redirect: 'manual',
        headers: {
          ...(sameSite && cookies.size ? { cookie: cookieHeader() } : {}),
          ...(method === 'POST'
            ? { 'content-type': 'application/x-www-form-urlencoded', origin: new URL(base).origin }
            : {}),
        },
        ...(body !== undefined ? { body } : {}),
      });
      if (sameSite) keep(response);
      const location = response.headers.get('location');
      if (!follow || response.status < 300 || response.status >= 400 || !location) {
        return {
          status: response.status,
          url: current,
          html: await response.text(),
          ...(location ? { location } : {}),
        };
      }
      current = new URL(location, current).toString();
      method = 'GET';
      body = undefined;
    }
    throw new Error('too many redirects');
  }

  return {
    get: (url: string, follow = true) => request(url, {}, follow),
    post: (url: string, form: Record<string, string>, follow = true) =>
      request(url, { method: 'POST', body: new URLSearchParams(form).toString() }, follow),
    cookies,
  };
}
