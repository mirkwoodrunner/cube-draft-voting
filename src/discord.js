'use strict';

/**
 * Optional player login through Discord (OAuth2, "identify" scope only).
 * Turned on by DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET. Everything else in
 * the app works without it.
 *
 * The browser holds a random login token in an HttpOnly cookie and the
 * database holds its hash, so one player can log out without affecting anyone
 * else. Discord's access token is used once to read the profile and dropped.
 */

const crypto = require('crypto');
const { pool } = require('./db');

const COOKIE = 'player';
const STATE_COOKIE = 'discord_state';
const MAX_AGE_S = 90 * 24 * 3600;
const DISCORD = 'https://discord.com';

const clientId = () => process.env.DISCORD_CLIENT_ID || '';
const clientSecret = () => process.env.DISCORD_CLIENT_SECRET || '';
const enabled = () => Boolean(clientId() && clientSecret());

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

function readCookie(req, name) {
  for (const part of (req.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookieFlags(req) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** The callback URL registered in the Discord developer portal. */
function redirectUri(req) {
  if (process.env.DISCORD_REDIRECT_URI) return process.env.DISCORD_REDIRECT_URI;
  const proto = req.get('x-forwarded-proto') || req.protocol;
  return `${proto}://${req.get('host')}/auth/discord/callback`;
}

/** Only same-site paths, so the login can't be used to bounce someone to another site. */
function safeNext(v) {
  const s = typeof v === 'string' ? v : '';
  return /^\/(?![/\\])[^\s]*$/.test(s) ? s : '/';
}

const avatarUrl = (discordId, avatar) =>
  avatar ? `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=128` : null;

const playerDto = (p) => ({ id: p.id, name: p.display_name, avatarUrl: avatarUrl(p.discord_id, p.avatar) });

/** Sends the browser to Discord. The state value ties the callback to this browser. */
function start(req, res) {
  const state = newToken();
  const next = safeNext(req.query.next);
  res.set('Set-Cookie', `${STATE_COOKIE}=${encodeURIComponent(`${state}|${next}`)}; Max-Age=600; ${cookieFlags(req)}`);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(),
    scope: 'identify',
    state,
    redirect_uri: redirectUri(req),
    prompt: 'none'
  });
  res.redirect(`${DISCORD}/oauth2/authorize?${q}`);
}

async function discordJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Discord returned ${r.status}`);
  return r.json();
}

/** Handles Discord's redirect back: checks state, reads the profile, saves the player and logs them in. */
async function callback(req, res) {
  const saved = readCookie(req, STATE_COOKIE) || '';
  const sep = saved.indexOf('|');
  const state = sep > 0 ? saved.slice(0, sep) : '';
  const next = safeNext(sep > 0 ? saved.slice(sep + 1) : '/');
  const clear = `${STATE_COOKIE}=; Max-Age=0; ${cookieFlags(req)}`;

  const fail = (msg) => {
    res.set('Set-Cookie', clear);
    res.status(400).type('text').send(`Discord login failed: ${msg}. Go back and try again.`);
  };
  if (req.query.error) return fail('the request was cancelled');
  const given = String(req.query.state || '');
  if (!state || given.length !== state.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(state))) {
    return fail('the login link expired');
  }
  if (!req.query.code) return fail('Discord did not send a code');

  let user;
  try {
    const tok = await discordJson(`${DISCORD}/api/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        grant_type: 'authorization_code',
        code: String(req.query.code),
        redirect_uri: redirectUri(req)
      })
    });
    user = await discordJson(`${DISCORD}/api/users/@me`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  } catch (err) {
    console.error('Discord login:', err.message);
    return fail('Discord could not be reached');
  }
  if (!user || !user.id) return fail('Discord did not return a profile');

  const display = String(user.global_name || user.username || 'Player').slice(0, 40);
  const { rows } = await pool.query(
    `INSERT INTO players (discord_id, username, display_name, avatar, last_login_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (discord_id) DO UPDATE SET username = EXCLUDED.username, display_name = EXCLUDED.display_name,
       avatar = EXCLUDED.avatar, last_login_at = now()
     RETURNING id`,
    [String(user.id), String(user.username || ''), display, user.avatar || null]
  );

  const token = newToken();
  await pool.query(
    `INSERT INTO player_logins (token_hash, player_id, expires_at) VALUES ($1, $2, now() + interval '${MAX_AGE_S} seconds')`,
    [sha256(token), rows[0].id]
  );
  await pool.query('DELETE FROM player_logins WHERE expires_at < now()');
  res.set('Set-Cookie', [clear, `${COOKIE}=${token}; Max-Age=${MAX_AGE_S}; ${cookieFlags(req)}`]);
  res.redirect(next);
}

/** The logged-in player row, or null. */
async function currentPlayer(req) {
  if (!enabled()) return null;
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT p.* FROM player_logins l JOIN players p ON p.id = l.player_id
     WHERE l.token_hash = $1 AND l.expires_at > now()`,
    [sha256(token)]
  );
  return rows[0] || null;
}

async function logout(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) await pool.query('DELETE FROM player_logins WHERE token_hash = $1', [sha256(token)]);
  res.set('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags(req)}`);
}

module.exports = { enabled, start, callback, currentPlayer, logout, playerDto, safeNext };
