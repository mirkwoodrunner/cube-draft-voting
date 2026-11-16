'use strict';

/**
 * Site owner login. The owner can see and open every draft, including ones whose
 * admin link was lost, and manage the cube library.
 *
 * Two ways in, either or both can be turned on:
 * - OWNER_DISCORD_IDS: Discord user IDs (comma separated). A player logged in with
 *   Discord whose ID is on the list is the owner. Logging out of Discord ends it.
 * - ADMIN_PASSWORD: a password login. Kept as a backup for when Discord login is
 *   down. The cookie is an HMAC of the password, so changing it logs out every browser.
 */

const crypto = require('crypto');
const discord = require('./discord');

const COOKIE = 'owner';
const MAX_AGE_S = 30 * 24 * 3600;

const password = () => process.env.ADMIN_PASSWORD || '';
const passwordEnabled = () => password().length > 0;
const discordIds = () => (process.env.OWNER_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const discordEnabled = () => discord.enabled() && discordIds().length > 0;
const enabled = () => passwordEnabled() || discordEnabled();
const cookieValue = () => crypto.createHmac('sha256', password()).update('cube-draft-owner-v1').digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of (req.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function hasPasswordCookie(req) {
  if (!passwordEnabled()) return false;
  const c = readCookie(req, COOKIE);
  return c !== null && safeEqual(c, cookieValue());
}

const isOwnerPlayer = (p) => Boolean(p && discordEnabled() && discordIds().includes(String(p.discord_id)));

/** True when the request comes from the owner, by Discord login or by password. */
async function isOwner(req) {
  if (hasPasswordCookie(req)) return true;
  return discordEnabled() && isOwnerPlayer(await discord.currentPlayer(req));
}

function cookieFlags(req) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Returns true and sets the cookie when the password matches. */
async function login(req, res, attempt) {
  if (!passwordEnabled() || typeof attempt !== 'string' || !safeEqual(attempt, password())) {
    await new Promise((r) => setTimeout(r, 750)); // slows down guessing
    return false;
  }
  res.set('Set-Cookie', `${COOKIE}=${cookieValue()}; Max-Age=${MAX_AGE_S}; ${cookieFlags(req)}`);
  return true;
}

/** Ends the password login. Appends, so it can go with the Discord logout cookie. */
function logout(req, res) {
  res.append('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags(req)}`);
}

module.exports = { enabled, passwordEnabled, discordEnabled, isOwner, isOwnerPlayer, login, logout };
