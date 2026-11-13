'use strict';

/**
 * Site owner login. The owner sets ADMIN_PASSWORD and can then see and open
 * every draft, including ones whose admin link was lost, and manage the cube
 * library. The login cookie is an HMAC of the password, so changing the
 * password logs out every browser.
 */

const crypto = require('crypto');

const COOKIE = 'owner';
const MAX_AGE_S = 30 * 24 * 3600;

const password = () => process.env.ADMIN_PASSWORD || '';
const enabled = () => password().length > 0;
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

function isOwner(req) {
  if (!enabled()) return false;
  const c = readCookie(req, COOKIE);
  return c !== null && safeEqual(c, cookieValue());
}

function cookieFlags(req) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Returns true and sets the cookie when the password matches. */
async function login(req, res, attempt) {
  if (!enabled() || typeof attempt !== 'string' || !safeEqual(attempt, password())) {
    await new Promise((r) => setTimeout(r, 750)); // slows down guessing
    return false;
  }
  res.set('Set-Cookie', `${COOKIE}=${cookieValue()}; Max-Age=${MAX_AGE_S}; ${cookieFlags(req)}`);
  return true;
}

function logout(req, res) {
  res.set('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags(req)}`);
}

module.exports = { enabled, isOwner, login, logout };
