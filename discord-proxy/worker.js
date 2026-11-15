/**
 * Cloudflare Worker that passes the app's two Discord login calls through to Discord.
 * Render's shared IPs get blocked by Discord's firewall, and this sends the calls
 * from Cloudflare instead. Only those two calls are allowed, and only with the key,
 * so it can't be used as an open proxy.
 *
 * Setup: paste this into a new Worker, add a secret named PROXY_KEY, and put the
 * same value in the app's DISCORD_PROXY_KEY. Set the app's DISCORD_API_BASE to the
 * Worker's URL.
 */
const ALLOWED = { '/api/oauth2/token': 'POST', '/api/users/@me': 'GET' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = request.headers.get('x-proxy-key') || '';
    if (!env.PROXY_KEY || key.length !== env.PROXY_KEY.length || key !== env.PROXY_KEY) {
      return new Response('Forbidden', { status: 403 });
    }
    if (ALLOWED[url.pathname] !== request.method) return new Response('Not found', { status: 404 });

    const headers = new Headers();
    for (const h of ['content-type', 'authorization']) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    return fetch(`https://discord.com${url.pathname}`, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? await request.text() : undefined
    });
  }
};
