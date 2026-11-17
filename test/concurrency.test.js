'use strict';
/**
 * Runs the real server against a real Postgres. Skipped unless TEST_DATABASE_URL is set,
 * for example: TEST_DATABASE_URL=postgres://postgres@localhost:5432/cube_test npm test
 * The database is written to, so point it at a throwaway one.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const DB = process.env.TEST_DATABASE_URL;
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}/api`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const json = { 'content-type': 'application/json' };
// Every request gives up, so a regression fails the test instead of hanging it.
const fetch = (url, init = {}) => globalThis.fetch(url, { signal: AbortSignal.timeout(20000), ...init });

test('database concurrency', { skip: DB ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: DB });
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), DISCORD_CLIENT_ID: 'test', DISCORD_CLIENT_SECRET: 'test', ADMIN_PASSWORD: 'right-password' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => { server.kill(); await db.end(); });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (/Server running/.test(d)) resolve(); });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });

  const tag = crypto.randomBytes(4).toString('hex');
  const loggedIn = async (n) => {
    const cookies = [];
    for (let i = 0; i < n; i++) {
      const { rows } = await db.query("INSERT INTO players (discord_id, username, display_name) VALUES ($1, $1, $1) RETURNING id", [`t-${tag}-${i}`]);
      const token = crypto.randomBytes(16).toString('hex');
      await db.query("INSERT INTO player_logins (token_hash, player_id, expires_at) VALUES ($1, $2, now() + interval '1 day')", [sha(token), rows[0].id]);
      cookies.push(`player=${token}`);
    }
    return cookies;
  };
  const newDraft = async (cubes) => (await fetch(`${BASE}/sessions`, { method: 'POST', headers: json, body: JSON.stringify({ title: 'test', cubes }) })).json();

  await t.test('many players reporting at once do not deadlock the connection pool', async () => {
    const N = 16; // more than the pool's 10 connections
    const cookies = await loggedIn(N);
    const s = await newDraft([{ url: `pool-${tag}`, name: 'A', minPlayers: 2, maxPlayers: 64 }]);
    const { cubes } = await (await fetch(`${BASE}/sessions/${s.sessionId}`)).json();
    for (let i = 0; i < N; i++) {
      await fetch(`${BASE}/sessions/${s.sessionId}/vote`, { method: 'POST', headers: { ...json, cookie: cookies[i] }, body: JSON.stringify({ playerName: `P${i}`, preferences: [cubes[0].id] }) });
    }
    await fetch(`${BASE}/admin/${s.adminToken}/close`, { method: 'POST' });
    await fetch(`${BASE}/admin/${s.adminToken}/assign`, { method: 'POST' });

    const statuses = await Promise.all(cookies.map((cookie, i) => fetch(`${BASE}/drafts/${s.sessionId}/matches`, {
      method: 'POST', headers: { ...json, cookie },
      body: JSON.stringify({ round: (i % 20) + 1, opponent: `P${(i + 1) % N}`, wins: 2, losses: 1, draws: 0 }),
      signal: AbortSignal.timeout(20000)
    }).then((r) => r.status)));
    assert.ok(statuses.every((c) => c < 500), `got ${statuses}`);
    assert.ok(statuses.filter((c) => c === 201).length >= N / 2, `got ${statuses}`);
    const probe = await fetch(`${BASE}/library`, { signal: AbortSignal.timeout(5000) });
    assert.strictEqual(probe.status, 200);
  });

  await t.test('a draft made by a non-owner cannot rewrite a saved cube', async () => {
    const url = `lib-${tag}`;
    await newDraft([{ url, name: 'Original', minPlayers: 2, maxPlayers: 8, save: true }]);
    await newDraft([{ url, name: 'Vandalized', minPlayers: 1, maxPlayers: 64, save: true }]);
    const { rows } = await db.query('SELECT name, max_players FROM saved_cubes WHERE cubecobra_id = $1', [url]);
    assert.deepStrictEqual(rows[0], { name: 'Original', max_players: 8 });
  });

  await t.test('editing cubes rewrites every ballot in place', async () => {
    const s = await newDraft([{ url: `e1-${tag}`, name: 'One' }, { url: `e2-${tag}`, name: 'Two' }, { url: `e3-${tag}`, name: 'Three' }]);
    const { cubes } = await (await fetch(`${BASE}/sessions/${s.sessionId}`)).json();
    const [a, b, c] = cubes.map((x) => x.id);
    await fetch(`${BASE}/sessions/${s.sessionId}/vote`, { method: 'POST', headers: json, body: JSON.stringify({ playerName: 'Ann', preferences: [c, a, b] }) });
    const body = { cubes: [{ id: a, url: `e1-${tag}`, name: 'One' }, { id: c, url: `e3-${tag}`, name: 'Three' }, { url: `e4-${tag}`, name: 'Four' }] };
    const r = await fetch(`${BASE}/admin/${s.adminToken}/cubes`, { method: 'PUT', headers: json, body: JSON.stringify(body) });
    assert.strictEqual(r.status, 200);
    const { rows: [cube4] } = await db.query("SELECT id FROM cubes WHERE cubecobra_id = $1", [`e4-${tag}`]);
    const { rows: [vote] } = await db.query("SELECT v.preferences FROM votes v JOIN sessions s ON s.id = v.session_id WHERE s.public_id = $1", [s.sessionId]);
    assert.deepStrictEqual(vote.preferences, [c, a, cube4.id]);
  });

  await t.test('owner password guessing is cut off', async () => {
    const tries = await Promise.all(Array.from({ length: 15 }, () =>
      fetch(`${BASE}/owner/login`, { method: 'POST', headers: json, body: JSON.stringify({ password: 'wrong' }) }).then((r) => r.status)));
    assert.strictEqual(tries.filter((c) => c === 401).length, 10);
    assert.strictEqual(tries.filter((c) => c === 429).length, 5);
  });
});
