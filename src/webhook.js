'use strict';

/**
 * Posts deck reports to a Discord channel through a webhook. Off unless
 * DISCORD_WEBHOOK_URL is set. When DISCORD_API_BASE points at the proxy Worker
 * (see discord-proxy/), the post goes through it too, since Discord's firewall
 * blocks some shared hosting IPs.
 */

const WEBHOOK = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com(\/api\/webhooks\/\d+\/[\w-]+)\/?$/;

const parsed = () => WEBHOOK.exec(process.env.DISCORD_WEBHOOK_URL || '');
const enabled = () => Boolean(parsed());

function target() {
  const path = parsed()[1];
  const base = (process.env.DISCORD_API_BASE || 'https://discord.com').replace(/\/+$/, '');
  const headers = process.env.DISCORD_PROXY_KEY ? { 'x-proxy-key': process.env.DISCORD_PROXY_KEY } : {};
  return { url: `${base}${path}?wait=true`, headers };
}

// Discord turns down webhook names with these words in them.
const safeName = (name) => (name && !/discord|clyde|everyone|here/i.test(name) ? name.slice(0, 80) : 'Cube Draft');

/**
 * Sends `messages` (each up to 2000 characters) as `username`, with the photo on the
 * first one. Mentions are turned off, so a report can't ping anyone.
 */
async function post({ username, avatarUrl, messages, photo }) {
  const { url, headers } = target();
  for (let i = 0; i < messages.length; i++) {
    const payload = { content: messages[i], username: safeName(username), allowed_mentions: { parse: [] } };
    if (avatarUrl) payload.avatar_url = avatarUrl;
    const form = new FormData();
    if (i === 0 && photo) {
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[photo.mime] || 'jpg';
      payload.attachments = [{ id: 0, filename: `deck.${ext}` }];
      form.append('files[0]', new Blob([photo.data], { type: photo.mime }), `deck.${ext}`);
    }
    form.append('payload_json', JSON.stringify(payload));
    let r;
    try {
      r = await fetch(url, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      throw Object.assign(new Error(`network error: ${err.message}`), { userMsg: 'Discord could not be reached' });
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      const blocked = r.status === 429 && /^\s*</.test(body);
      const userMsg = blocked ? "Discord's firewall is blocking this server. Set up the Discord proxy (see the README)"
        : r.status === 404 || r.status === 401 ? 'The Discord webhook no longer works. Ask the owner to check DISCORD_WEBHOOK_URL'
          : `Discord turned down the post (${r.status})`;
      throw Object.assign(new Error(`Discord webhook returned ${r.status} ${body.slice(0, 300)}`), { userMsg });
    }
  }
}

module.exports = { enabled, post, safeName };
