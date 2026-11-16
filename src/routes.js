'use strict';

const crypto = require('crypto');
const express = require('express');
const { pool } = require('./db');
const { fetchCubeInfo, parseCubeUrl, CubeCobraError } = require('./cubecobra');
const { assignPods } = require('./borda');
const pods = require('./pods');
const owner = require('./owner');
const discord = require('./discord');
const records = require('./records');
const matches = require('./matches');
const decks = require('./decks');
const webhook = require('./webhook');

const router = express.Router();

const MAX_CUBES = 12;
const MAX_PLAYERS_PER_POD = 64;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/** Runs `fn(client)` in a transaction and returns what it returns. */
async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
const newToken = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- shaping rows for the client ----------

const cubeDto = (c) => ({
  id: c.id,
  name: c.name,
  author: c.author,
  url: c.url,
  cardCount: c.card_count,
  minPlayers: c.min_players,
  maxPlayers: c.max_players
});

async function loadCubes(sessionId, db = pool) {
  const { rows } = await db.query('SELECT * FROM cubes WHERE session_id = $1 ORDER BY id', [sessionId]);
  return rows;
}

async function sessionByPublicId(publicId) {
  const { rows } = await pool.query('SELECT * FROM sessions WHERE public_id = $1', [String(publicId)]);
  if (!rows[0]) throw new HttpError(404, 'Session not found');
  return rows[0];
}

async function sessionByAdminToken(token) {
  const { rows } = await pool.query('SELECT * FROM sessions WHERE admin_token = $1', [String(token)]);
  if (!rows[0]) throw new HttpError(404, 'Admin link not found');
  return rows[0];
}

// ---------- input validation ----------

function cleanText(v, max, label, { required = false } = {}) {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!s) {
    if (required) throw new HttpError(400, `${label} is required`);
    return null;
  }
  if (s.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer`);
  return s;
}

function cleanInt(v, fallback, label, min, max) {
  const n = v === undefined || v === null || v === '' ? fallback : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

async function resolveCube(input, index, label = `Cube ${index + 1}`) {
  if (!input || typeof input !== 'object') throw new HttpError(400, `${label} is invalid`);

  let parsed;
  try {
    parsed = parseCubeUrl(input.url);
  } catch (err) {
    throw new HttpError(400, `${label}: ${err.message}`);
  }

  const minPlayers = cleanInt(input.minPlayers, 6, `${label} minimum players`, 1, MAX_PLAYERS_PER_POD);
  const maxPlayers = cleanInt(input.maxPlayers, 8, `${label} maximum players`, 1, MAX_PLAYERS_PER_POD);
  if (minPlayers > maxPlayers) throw new HttpError(400, `${label}: minimum players cannot exceed maximum players`);

  // Details the admin already previewed (and may have edited) are used as-is.
  // Otherwise look them up now.
  let info;
  if (typeof input.name === 'string' && input.name.trim()) {
    const count = input.cardCount === null || input.cardCount === undefined || input.cardCount === '' ? null : Number(input.cardCount);
    info = {
      name: cleanText(input.name, 200, `${label} name`, { required: true }),
      author: cleanText(input.author, 100, `${label} author`),
      cardCount: Number.isInteger(count) && count >= 0 && count <= 100000 ? count : null
    };
  } else {
    try {
      info = await fetchCubeInfo(input.url);
    } catch (err) {
      if (err instanceof CubeCobraError) throw new HttpError(422, `${label}: ${err.message}`);
      throw err;
    }
  }
  return { ...info, cubecobraId: parsed.id, url: parsed.url, minPlayers, maxPlayers, save: input.save === true };
}

async function resolveCubeList(input, emptyMessage) {
  if (!Array.isArray(input) || input.length < 1) throw new HttpError(400, emptyMessage);
  if (input.length > MAX_CUBES) throw new HttpError(400, `A session can have at most ${MAX_CUBES} cubes`);
  const cubes = await Promise.all(input.map((c, i) => resolveCube(c, i)));
  const seen = new Set();
  for (const c of cubes) {
    if (seen.has(c.cubecobraId)) throw new HttpError(400, `The cube "${c.name}" was added more than once`);
    seen.add(c.cubecobraId);
  }
  return cubes;
}

/** Adds the cubes marked "save" to the library, or refreshes their saved details. */
async function saveToLibrary(db, cubes) {
  for (const c of cubes.filter((x) => x.save)) {
    await db.query(
      `INSERT INTO saved_cubes (cubecobra_id, url, name, author, card_count, min_players, max_players)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (cubecobra_id) DO UPDATE SET url = EXCLUDED.url, name = EXCLUDED.name, author = EXCLUDED.author,
         card_count = EXCLUDED.card_count, min_players = EXCLUDED.min_players, max_players = EXCLUDED.max_players, last_used_at = now()`,
      [c.cubecobraId, c.url, c.name, c.author, c.cardCount, c.minPlayers, c.maxPlayers]
    );
  }
}

async function requireOwner(req) {
  if (!owner.enabled()) throw new HttpError(403, LOGIN_OFF);
  if (!(await owner.isOwner(req))) throw new HttpError(401, 'Log in as the owner first');
}

// ---------- Cube Cobra preview ----------

router.post('/cubecobra/preview', wrap(async (req, res) => {
  try {
    res.json({ cube: await fetchCubeInfo(req.body.url) });
  } catch (err) {
    if (err instanceof CubeCobraError) throw new HttpError(err.status === 400 ? 400 : 422, err.message);
    throw err;
  }
}));

// ---------- create a session (admin flow) ----------

router.post('/sessions', wrap(async (req, res) => {
  const title = cleanText(req.body.title, 120, 'Title', { required: true });
  const teamMode = req.body.teamMode === true;
  const cubes = await resolveCubeList(req.body.cubes, 'Add at least one cube');

  const publicId = newToken(8);
  const adminToken = newToken(24);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO sessions (title, public_id, admin_token, team_mode) VALUES ($1, $2, $3, $4) RETURNING id',
      [title, publicId, adminToken, teamMode]
    );
    for (const c of cubes) {
      await client.query(
        `INSERT INTO cubes (session_id, name, url, cubecobra_id, author, card_count, min_players, max_players)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [rows[0].id, c.name, c.url, c.cubecobraId, c.author, c.cardCount, c.minPlayers, c.maxPlayers]
      );
    }
    await saveToLibrary(client, cubes);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({
    sessionId: publicId,
    adminToken,
    voteUrl: `/vote/${publicId}`,
    adminUrl: `/admin/${adminToken}`
  });
}));

// ---------- player voting ----------

router.get('/sessions/:sessionId', wrap(async (req, res) => {
  const s = await sessionByPublicId(req.params.sessionId);
  res.json({
    session: { id: s.public_id, title: s.title, status: s.status, teamMode: s.team_mode },
    cubes: (await loadCubes(s.id)).map(cubeDto)
  });
}));

// A returning player sends the edit token their browser saved when they first voted.
// A logged-in player gets the ballot tied to their account first, on any device.
router.get('/sessions/:sessionId/ballot', wrap(async (req, res) => {
  const s = await sessionByPublicId(req.params.sessionId);
  const player = await discord.currentPlayer(req);
  const token = req.get('x-voter-token');
  let row = null;
  if (player) {
    ({ rows: [row] } = await pool.query('SELECT player_name, preferences FROM votes WHERE session_id = $1 AND player_id = $2', [s.id, player.id]));
  }
  if (!row && token) {
    ({ rows: [row] } = await pool.query('SELECT player_name, preferences FROM votes WHERE session_id = $1 AND token_hash = $2', [s.id, sha256(token)]));
  }
  res.json({ ballot: row ? { playerName: row.player_name, preferences: row.preferences } : null });
}));

/**
 * Saves or updates one ballot. `voterToken` is the edit token the caller holds.
 * `insertToken` (admin only) is the token to store when this is a new ballot,
 * instead of issuing a random one. `playerId` is the logged-in Discord player,
 * whose ballot is found by account instead of by token.
 */
async function saveBallot(s, playerName, prefs, voterToken, insertToken = null, playerId = null) {
  const cubes = await loadCubes(s.id);
  const cubeIds = cubes.map((c) => String(c.id));
  const ranked = Array.isArray(prefs) ? prefs.map(String) : [];
  if (ranked.length !== cubeIds.length || new Set(ranked).size !== ranked.length || !ranked.every((id) => cubeIds.includes(id))) {
    throw new HttpError(400, 'Your ballot must rank every cube exactly once');
  }
  const preferences = ranked.map(Number);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Holds off a concurrent "Close Voting" or cube edit until this ballot is saved.
    const { rows: st } = await client.query('SELECT status FROM sessions WHERE id = $1 FOR SHARE', [s.id]);
    if (st[0].status !== 'open') throw new HttpError(403, 'Voting is closed for this session', 'closed');

    // The cube list may have changed since it was read above.
    const { rows: now } = await client.query('SELECT id FROM cubes WHERE session_id = $1', [s.id]);
    if (now.length !== cubeIds.length || !now.every((c) => cubeIds.includes(String(c.id)))) {
      throw new HttpError(409, 'The cubes for this session just changed. Reload the page and rank them again.', 'cubes_changed');
    }

    const nameTaken = () => new HttpError(409, 'Someone has already voted under that name. Pick a different name.', 'name_taken');
    const prefsJson = JSON.stringify(preferences);

    // An existing ballot is updated (renaming is allowed). A logged-in player's ballot is found by
    // account. Otherwise the browser's edit token finds it, and logging in links that ballot to the account.
    let issued = null;
    let isUpdate = false;
    const update = async (where, params) => {
      try {
        const out = await client.query(
          `UPDATE votes SET player_name = $2, preferences = $3, updated_at = now(), player_id = COALESCE(player_id, $4::int)
           WHERE session_id = $1 AND ${where} RETURNING token_hash`,
          [s.id, playerName, prefsJson, playerId, ...params]
        );
        return out.rowCount > 0;
      } catch (err) {
        if (err.code === '23505') throw nameTaken();
        throw err;
      }
    };
    if (playerId !== null && await update('player_id = $5', [playerId])) {
      isUpdate = true;
      issued = voterToken;
    } else if (voterToken && await update('token_hash = $5 AND ($4::int IS NULL OR player_id IS NULL OR player_id = $4::int)', [sha256(voterToken)])) {
      isUpdate = true;
      issued = voterToken;
    }

    if (!isUpdate) {
      issued = insertToken || newToken(24);
      const inserted = await client.query(
        `INSERT INTO votes (session_id, player_name, preferences, token_hash, player_id)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
        [s.id, playerName, prefsJson, sha256(issued), playerId]
      );
      if (!inserted.rowCount) throw nameTaken();
    }
    await client.query('COMMIT');
    return { success: true, voterToken: issued, updated: isUpdate };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

router.post('/sessions/:sessionId/vote', wrap(async (req, res) => {
  const playerName = cleanText(req.body.playerName, 40, 'Name', { required: true });
  const voterToken = typeof req.body.voterToken === 'string' ? req.body.voterToken : null;
  const s = await sessionByPublicId(req.params.sessionId);
  const player = await discord.currentPlayer(req);
  res.json(await saveBallot(s, playerName, req.body.preferences, voterToken, null, player ? player.id : null));
}));

// ---------- admin dashboard ----------

// The admin's own ballot is keyed to their admin token. When the admin is logged in
// with Discord, linkAdminBallot also ties it to their player record.
const adminVoterToken = (adminToken) => `admin:${adminToken}`;

async function adminView(s, req) {
  await matches.hydrate(pool, [s]);
  const cubes = await loadCubes(s.id);
  const myHash = sha256(adminVoterToken(s.admin_token));
  const { rows: votes } = await pool.query(
    'SELECT id, player_name, preferences, updated_at, token_hash, player_id FROM votes WHERE session_id = $1 ORDER BY created_at, id',
    [s.id]
  );
  const linked = await linkedPlayers(records.linkedNames(s.results, votes));
  return {
    session: {
      id: s.public_id,
      title: s.title,
      status: s.status,
      teamMode: s.team_mode,
      createdAt: s.created_at,
      closedAt: s.closed_at,
      assignedAt: s.assigned_at
    },
    cubes: cubes.map(cubeDto),
    voteCount: votes.length,
    voters: votes.map((v) => ({ id: v.id, name: v.player_name, preferences: v.preferences, updatedAt: v.updated_at, you: v.token_hash === myHash })),
    results: s.results || null,
    standings: s.results ? pods.standings(s.results, s.team_mode) : null,
    linked,
    photos: await decks.photosByName(pool, s.id, s.public_id),
    deckNames: Object.fromEntries(Object.entries(await decks.byName(pool, s.id, s.public_id)).filter(([, x]) => x.deckName).map(([n, x]) => [n, x.deckName])),
    isOwner: await owner.isOwner(req)
  };
}

/** { name: { id, name, avatarUrl } } for the names in a draft that belong to a Discord player. */
async function linkedPlayers(byName) {
  const ids = [...new Set(byName.values())];
  if (!ids.length) return {};
  const { rows } = await pool.query('SELECT * FROM players WHERE id = ANY($1::int[])', [ids]);
  const byId = new Map(rows.map((p) => [p.id, discord.playerDto(p)]));
  const out = {};
  for (const [name, id] of byName) if (byId.has(id)) out[name] = byId.get(id);
  return out;
}

/** Sends the refreshed dashboard after an admin action. */
const sendView = async (req, res) => res.json(await adminView(await sessionByAdminToken(req.params.adminToken), req));

/**
 * Links the admin's own ballot to the logged-in Discord player, so the draft lands on
 * their player record. Skipped when that player already has another ballot in this draft
 * (for example one cast through the public voting link), which already links them.
 * After pods are assigned, the match table and the draft's name map are updated too.
 */
async function linkAdminBallot(s, req) {
  const player = await discord.currentPlayer(req);
  if (!player) return;
  await inTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE votes SET player_id = $3
       WHERE session_id = $1 AND token_hash = $2 AND player_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM votes WHERE session_id = $1 AND player_id = $3)
       RETURNING player_name`,
      [s.id, sha256(adminVoterToken(s.admin_token)), player.id]
    );
    if (!rows[0]) return;
    const { rows: [fresh] } = await client.query('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [s.id]);
    if (!fresh.results) return;
    const name = rows[0].player_name;
    const playerIds = fresh.results.playerIds || {};
    if (playerIds[name] !== undefined || Object.values(playerIds).map(Number).includes(player.id)) return;
    await matches.hydrate(client, [fresh]);
    const results = { ...fresh.results, playerIds: { ...playerIds, [name]: player.id } };
    await client.query('UPDATE sessions SET results = $2 WHERE id = $1', [s.id, await matches.store(client, s.id, results)]);
  });
}

router.get('/admin/:adminToken', wrap(async (req, res) => {
  await linkAdminBallot(await sessionByAdminToken(req.params.adminToken), req);
  await sendView(req, res);
}));

router.post('/admin/:adminToken/close', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  if (s.status === 'open') {
    await pool.query("UPDATE sessions SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'open'", [s.id]);
  }
  await sendView(req, res);
}));

router.post('/admin/:adminToken/assign', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  if (s.status === 'open') throw new HttpError(409, 'Close voting before running the assignment');

  const cubes = (await loadCubes(s.id)).map((c) => ({
    id: String(c.id), name: c.name, author: c.author, url: c.url,
    minPlayers: c.min_players, maxPlayers: c.max_players
  }));
  const { rows: votes } = await pool.query('SELECT player_name, preferences, player_id FROM votes WHERE session_id = $1', [s.id]);
  let results = assignPods(cubes, votes.map((v) => ({ name: v.player_name, preferences: v.preferences })));
  const playerIds = Object.fromEntries(votes.filter((v) => v.player_id !== null).map((v) => [v.player_name, v.player_id]));
  results = { ...(s.team_mode ? pods.setTeamMode(results, true) : results), matches: [], playerIds, computedAt: new Date().toISOString() };

  await inTransaction(async (client) => {
    await matches.clear(client, s.id);
    await client.query("UPDATE sessions SET results = $2, status = 'assigned', assigned_at = now() WHERE id = $1", [s.id, await matches.store(client, s.id, results)]);
  });
  await sendView(req, res);
}));

// Wipes computed pods. Used whenever the cubes or the voter list change after an assignment.
const STALE_RESULTS = "results = NULL, assigned_at = NULL, status = CASE WHEN status = 'assigned' THEN 'closed' ELSE status END";
async function clearResults(db, sessionId) {
  await matches.clear(db, sessionId);
  await db.query(`UPDATE sessions SET ${STALE_RESULTS} WHERE id = $1`, [sessionId]);
}

router.post('/admin/:adminToken/reopen', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  await inTransaction(async (client) => {
    await matches.clear(client, s.id);
    await client.query("UPDATE sessions SET status = 'open', closed_at = NULL, results = NULL, assigned_at = NULL WHERE id = $1", [s.id]);
  });
  await sendView(req, res);
}));

router.delete('/admin/:adminToken/voters/:voteId', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  const voteId = Number(req.params.voteId);
  if (!Number.isInteger(voteId)) throw new HttpError(400, 'Invalid voter');
  // Once pods are assigned, removing a voter takes them out of the pods and keeps everyone else's seats and results.
  if (s.status === 'assigned' && s.results) {
    await editResults(s, async (results, row, client) => {
      const del = await client.query('DELETE FROM votes WHERE id = $1 AND session_id = $2 RETURNING player_name', [voteId, s.id]);
      if (!del.rowCount) return results;
      const name = del.rows[0].player_name;
      const ctx = await podContext(s, row, client);
      ctx.preferences.set(name, []);
      return inResults(results, name) ? pods.removePlayer(results, name, ctx) : results;
    });
    return sendView(req, res);
  }
  const del = await pool.query('DELETE FROM votes WHERE id = $1 AND session_id = $2', [voteId, s.id]);
  if (del.rowCount) await inTransaction((client) => clearResults(client, s.id));
  await sendView(req, res);
}));

// ---------- admin as a player ----------

router.get('/admin/:adminToken/ballot', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  const { rows } = await pool.query(
    'SELECT player_name, preferences FROM votes WHERE session_id = $1 AND token_hash = $2',
    [s.id, sha256(adminVoterToken(s.admin_token))]
  );
  res.json({ ballot: rows[0] ? { playerName: rows[0].player_name, preferences: rows[0].preferences } : null });
}));

router.post('/admin/:adminToken/vote', wrap(async (req, res) => {
  const playerName = cleanText(req.body.playerName, 40, 'Name', { required: true });
  const s = await sessionByAdminToken(req.params.adminToken);
  const token = adminVoterToken(s.admin_token);
  const out = await saveBallot(s, playerName, req.body.preferences, token, token);
  await linkAdminBallot(s, req);
  res.json({ success: true, updated: out.updated });
}));

// "I'm not playing": removes the admin's ballot if there is one.
router.delete('/admin/:adminToken/ballot', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  const del = await pool.query('DELETE FROM votes WHERE session_id = $1 AND token_hash = $2', [s.id, sha256(adminVoterToken(s.admin_token))]);
  if (del.rowCount) await inTransaction((client) => clearResults(client, s.id));
  await sendView(req, res);
}));

// ---------- admin edits the cube list ----------

/**
 * Replaces the session's cubes with the submitted list. Entries with an `id`
 * update that cube, entries without one are added, and cubes left out are
 * removed. Ballots are fixed up to match: removed cubes drop out of every
 * ranking, and new cubes are appended to the bottom of every ranking.
 */
router.put('/admin/:adminToken/cubes', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  const input = req.body.cubes;
  const cubes = await resolveCubeList(input, 'A session needs at least one cube');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [s.id]);
    const { rows: existing } = await client.query('SELECT id FROM cubes WHERE session_id = $1', [s.id]);
    const existingIds = new Set(existing.map((c) => c.id));

    const keep = new Set();
    const added = [];
    for (let i = 0; i < cubes.length; i++) {
      const c = cubes[i];
      const id = input[i].id === undefined || input[i].id === null ? null : Number(input[i].id);
      if (id !== null && !existingIds.has(id)) throw new HttpError(409, 'The cube list changed in another window. Reload and try again.');
      if (id !== null && keep.has(id)) throw new HttpError(400, 'A cube was listed twice');
      if (id !== null) {
        keep.add(id);
        await client.query(
          `UPDATE cubes SET name = $2, url = $3, cubecobra_id = $4, author = $5, card_count = $6, min_players = $7, max_players = $8
           WHERE id = $1`,
          [id, c.name, c.url, c.cubecobraId, c.author, c.cardCount, c.minPlayers, c.maxPlayers]
        );
      } else {
        const { rows } = await client.query(
          `INSERT INTO cubes (session_id, name, url, cubecobra_id, author, card_count, min_players, max_players)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [s.id, c.name, c.url, c.cubecobraId, c.author, c.cardCount, c.minPlayers, c.maxPlayers]
        );
        added.push(rows[0].id);
      }
    }

    const removed = [...existingIds].filter((id) => !keep.has(id));
    if (removed.length) await client.query('DELETE FROM cubes WHERE id = ANY($1::int[])', [removed]);

    if (removed.length || added.length) {
      const { rows: votes } = await client.query('SELECT id, preferences FROM votes WHERE session_id = $1', [s.id]);
      const gone = new Set(removed);
      for (const v of votes) {
        const prefs = [...v.preferences.filter((id) => !gone.has(id)), ...added];
        await client.query('UPDATE votes SET preferences = $2 WHERE id = $1', [v.id, JSON.stringify(prefs)]);
      }
      await clearResults(client, s.id);
    }
    await saveToLibrary(client, cubes);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await sendView(req, res);
}));

// ---------- admin edits pods, teams and match results ----------

/**
 * Runs `fn(results, sessionRow, client)` on the stored assignment under a row
 * lock and saves what it returns.
 */
async function editResults(s, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [s.id]);
    const row = rows[0];
    if (row.status !== 'assigned' || !row.results) throw new HttpError(409, 'Assign pods first');
    await matches.hydrate(client, [row]);
    let next;
    try {
      next = await fn(row.results, row, client);
    } catch (err) {
      if (err instanceof pods.PodError) throw new HttpError(400, err.message);
      throw err;
    }
    await client.query('UPDATE sessions SET results = $2 WHERE id = $1', [s.id, await matches.store(client, s.id, next)]);
    await client.query('COMMIT');
    return next;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Turning team draft on or off re-splits (or un-splits) any assigned pods and clears their matches.
router.put('/admin/:adminToken/team-mode', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  const on = req.body.teamMode === true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT team_mode, results FROM sessions WHERE id = $1 FOR UPDATE', [s.id]);
    if (rows[0].team_mode !== on) {
      await matches.clear(client, s.id);
      const results = rows[0].results ? await matches.store(client, s.id, pods.setTeamMode(rows[0].results, on)) : null;
      await client.query('UPDATE sessions SET team_mode = $2, results = $3 WHERE id = $1', [s.id, on, results]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await sendView(req, res);
}));

/** What the pod functions need to know about the session: its cubes, ballots and format. */
async function podContext(s, row, client) {
  const cubes = (await loadCubes(s.id, client)).map(cubeDto);
  const { rows: votes } = await client.query('SELECT player_name, preferences, player_id FROM votes WHERE session_id = $1', [s.id]);
  return {
    cubes,
    preferences: new Map(votes.map((v) => [v.player_name, v.preferences])),
    voterNames: votes.map((v) => v.player_name),
    linkedIds: votes.filter((v) => v.player_id !== null).map((v) => v.player_id),
    teamMode: row.team_mode
  };
}

const inResults = (results, name) =>
  results.pods.some((p) => p.players.some((m) => m.name === name)) || results.unassigned.some((u) => u.name === name);
const targetCube = (v) => (v === null || v === undefined || v === '' ? null : String(v));

router.post('/admin/:adminToken/pods/move', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  const name = String(req.body.name || '');
  await editResults(s, async (results, row, client) => pods.movePlayer(results, name, targetCube(req.body.cubeId), await podContext(s, row, client)));
  await sendView(req, res);
}));

/**
 * Renames a player: their ballot if they voted, and their seat and matches if
 * pods are assigned. Works at any stage of the draft.
 */
router.post('/admin/:adminToken/players/rename', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  const from = String(req.body.from || '');
  const to = cleanText(req.body.to, 40, 'New name', { required: true });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, results FROM sessions WHERE id = $1 FOR UPDATE', [s.id]);
    await matches.hydrate(client, rows);
    const { rows: votes } = await client.query('SELECT id, player_name FROM votes WHERE session_id = $1', [s.id]);
    const ballot = votes.find((v) => v.player_name === from);
    const otherVoters = votes.filter((v) => v !== ballot).map((v) => v.player_name);
    if (otherVoters.some((n) => n.toLowerCase() === to.toLowerCase())) throw new HttpError(409, `${to} is already in this draft`);

    let results = rows[0].results;
    if (results) {
      try {
        results = pods.renamePlayer(results, from, to, otherVoters);
      } catch (err) {
        // A voter who isn't in the stored results (voted after pods were assigned) only needs their ballot renamed.
        if (!(err instanceof pods.PodError) || !ballot || !/is not in this draft/.test(err.message)) {
          throw err instanceof pods.PodError ? new HttpError(400, err.message) : err;
        }
        const names = [...results.pods.flatMap((p) => p.players), ...results.unassigned].map((p) => p.name)
          .concat((results.matches || []).flatMap((m) => [m.p1, m.p2]));
        if (names.some((n) => n.toLowerCase() === to.toLowerCase())) {
          throw new HttpError(409, `${to} is already in this draft`);
        }
      }
      await client.query('UPDATE sessions SET results = $2 WHERE id = $1', [s.id, await matches.store(client, s.id, results)]);
    } else if (!ballot) {
      throw new HttpError(404, `${from} is not in this draft`);
    }
    if (ballot) await client.query('UPDATE votes SET player_name = $2 WHERE id = $1', [ballot.id, to]);
    await client.query('UPDATE draft_decks SET player_name = $3, updated_at = now() WHERE draft_id = $1 AND player_name = $2', [s.id, from, to]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await sendView(req, res);
}));

// Someone who turned up after voting closed. They go straight into a pod without a ballot.
router.post('/admin/:adminToken/pods/add', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  const name = cleanText(req.body.name, 40, 'Name', { required: true });
  let playerId = null;
  if (req.body.playerId !== null && req.body.playerId !== undefined && req.body.playerId !== '') {
    playerId = Number(req.body.playerId);
    const { rowCount } = Number.isInteger(playerId) ? await pool.query('SELECT 1 FROM players WHERE id = $1', [playerId]) : { rowCount: 0 };
    if (!rowCount) throw new HttpError(400, 'That player was not found');
  }
  await editResults(s, async (results, row, client) =>
    pods.addPlayer(results, name, targetCube(req.body.cubeId), { ...(await podContext(s, row, client)), playerId }));
  await sendView(req, res);
}));

// Someone who is not playing after all. Their ballot is deleted too, so a re-run won't seat them again.
router.post('/admin/:adminToken/pods/remove', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  const name = String(req.body.name || '');
  await editResults(s, async (results, row, client) => {
    const next = pods.removePlayer(results, name, await podContext(s, row, client));
    await client.query('DELETE FROM votes WHERE session_id = $1 AND player_name = $2', [s.id, name]);
    await client.query('DELETE FROM draft_decks WHERE draft_id = $1 AND player_name = $2', [s.id, name]);
    return next;
  });
  await sendView(req, res);
}));

router.post('/admin/:adminToken/pods/switch-team', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  await editResults(s, (results, row) => {
    if (!row.team_mode) throw new HttpError(409, 'This is not a team draft');
    return pods.switchTeam(results, String(req.body.name || ''));
  });
  await sendView(req, res);
}));

router.post('/admin/:adminToken/pods/:cubeId/pairings', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  await editResults(s, (results, row) => {
    if (!row.team_mode) throw new HttpError(409, 'Pairings are generated only for team drafts');
    return pods.generateTeamPairings(results, req.params.cubeId, req.body.rounds);
  });
  await sendView(req, res);
}));

router.post('/admin/:adminToken/matches', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  await editResults(s, (results, row) => pods.addMatch(results, req.body, row.team_mode));
  await sendView(req, res);
}));

router.put('/admin/:adminToken/matches/:matchId', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  await editResults(s, (results) => correctMatch(results, req.params.matchId, req.body));
  await sendView(req, res);
}));

router.delete('/admin/:adminToken/matches/:matchId', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  await editResults(s, (results) => pods.deleteMatch(results, req.params.matchId));
  await sendView(req, res);
}));

// ---------- draft night: match reporting and standings ----------
// :id is the draft's public id, the one in its /vote/ link.

const isPlayedMatch = (m) => m.w1 !== null && m.w1 !== undefined;

/**
 * Changes a match's score. A match that already had a result is marked as edited,
 * so a corrected score can be told apart from one entered at the table.
 */
function correctMatch(results, id, input, { always = false } = {}) {
  const before = (results.matches || []).find((m) => m.id === id);
  const next = pods.updateMatch(results, id, input);
  if (always || (before && isPlayedMatch(before))) next.matches.find((m) => m.id === id).editedByOwner = true;
  return next;
}

const sameSecret = (a, b) => crypto.timingSafeEqual(Buffer.from(sha256(String(a))), Buffer.from(sha256(String(b))));

/** The draft's host (its admin link, sent as X-Admin-Token) or the site owner. */
async function requireHostOrOwner(req, s) {
  const token = req.get('x-admin-token');
  if (token && s.admin_token && sameSecret(token, s.admin_token)) return;
  if (await owner.isOwner(req)) return;
  throw new HttpError(403, 'Only the host or the site owner can change a reported match');
}

/** Ranked standings for every pod in a draft, with Discord players and 3-0 trophy winners. */
async function standingsView(s, db = pool) {
  const draft = { id: s.public_id, title: s.title, status: s.status, teamMode: s.team_mode };
  if (s.status !== 'assigned' || !s.results) return { draft, pods: [], trophies: [] };
  const { rows: votes } = await db.query('SELECT player_name, player_id FROM votes WHERE session_id = $1 AND player_id IS NOT NULL', [s.id]);
  const linked = records.linkedNames(s.results, votes);
  const all = pods.standings(s.results, s.team_mode);
  const deckRows = await decks.byName(db, s.id, s.public_id);
  const out = s.results.pods.map((pod) => {
    const st = all[pod.cubeId];
    return {
      cubeId: pod.cubeId,
      cubeName: pod.name,
      matchesPlayed: st.played,
      teamScore: st.teamScore,
      players: st.players.map((r) => ({
        rank: r.rank,
        name: r.name,
        playerId: linked.get(r.name) ?? null,
        team: r.team,
        matchPoints: r.points,
        wins: r.w,
        losses: r.l,
        draws: r.d,
        gamesWon: r.gw,
        gamesLost: r.gl,
        gamesDrawn: r.gd,
        gwp: r.gwp,
        trophy: r.trophy,
        deckName: deckRows[r.name] ? deckRows[r.name].deckName : null,
        photoUrl: deckRows[r.name] ? deckRows[r.name].photoUrl : null
      })),
      matches: (s.results.matches || []).filter((m) => m.cubeId === pod.cubeId).map(matches.dto)
    };
  });
  const trophies = out.flatMap((pod) => pod.players.filter((p) => p.trophy).map((p) => ({ name: p.name, playerId: p.playerId, cubeId: pod.cubeId, cubeName: pod.cubeName })));
  return { draft, pods: out, trophies };
}

async function matchById(s, id) {
  const m = (await matches.load(pool, [s.id])).get(s.id).find((x) => x.id === id);
  return m ? matches.dto(m) : null;
}

/**
 * The seat in a pod that belongs to whoever sent the request: the name linked to their
 * Discord login, or else the ballot their browser holds the edit token for
 * (X-Voter-Token). Returns { name, cubeId, playerId } or null.
 */
async function mySeat(req, s, results, db = pool) {
  if (!results || !results.pods) return null;
  const { rows: votes } = await db.query('SELECT player_name, player_id, token_hash FROM votes WHERE session_id = $1', [s.id]);
  const linked = records.linkedNames(results, votes.filter((v) => v.player_id !== null));
  const seat = (name) => {
    const pod = results.pods.find((p) => p.players.some((x) => x.name === name));
    return pod ? { name, cubeId: pod.cubeId, playerId: linked.get(name) ?? null } : null;
  };
  const me = await discord.currentPlayer(req);
  if (me) {
    for (const [name, id] of linked) if (id === me.id && seat(name)) return seat(name);
  }
  const token = req.get('x-voter-token');
  if (token) {
    const v = votes.find((x) => x.token_hash === sha256(token));
    if (v) return seat(v.player_name);
  }
  return null;
}

const NOT_SEATED = 'You are not seated in this draft. Log in with Discord, or open this page in the browser you voted from.';

/**
 * A player logs the result of their own match. They are found by their Discord login or
 * the edit token of their ballot (see mySeat), and must be seated in a pod. Body:
 * { round, opponent, wins, losses, draws }, counted from the reporter's side. A pairing
 * the host already set up is filled in. A match that already has a result can only be
 * changed by the host or the owner.
 */
router.post('/drafts/:id/matches', wrap(async (req, res) => {
  const s = await sessionByPublicId(req.params.id);
  const opponent = String(req.body.opponent || '');
  const round = Number(req.body.round);
  const score = { w1: req.body.wins, w2: req.body.losses, d: req.body.draws };
  let savedId = null;

  await editResults(s, async (results, row, client) => {
    const seat = await mySeat(req, s, results, client);
    if (!seat) throw new HttpError(403, NOT_SEATED);
    const name = seat.name;
    if (opponent === name) throw new HttpError(400, 'Pick your opponent');

    const pairing = results.matches.find((m) => m.cubeId === seat.cubeId && m.round === round &&
      ((m.p1 === name && m.p2 === opponent) || (m.p1 === opponent && m.p2 === name)));
    let next;
    if (pairing) {
      if (isPlayedMatch(pairing)) throw new HttpError(409, 'This match is already reported. Ask the host to correct it.');
      next = pods.updateMatch(results, pairing.id, pairing.p1 === name ? score : { w1: score.w2, w2: score.w1, d: score.d });
      savedId = pairing.id;
    } else {
      next = pods.addMatch(results, { cubeId: seat.cubeId, round, p1: name, p2: opponent, ...score }, row.team_mode);
      savedId = next.matches[next.matches.length - 1].id;
    }
    const saved = next.matches.find((m) => m.id === savedId);
    if (!isPlayedMatch(saved)) throw new HttpError(400, 'Enter games won for both players');
    saved.reportedBy = seat.playerId;
    return next;
  });

  const fresh = await sessionByPublicId(req.params.id);
  await matches.hydrate(pool, [fresh]);
  res.status(201).json({ match: await matchById(s, savedId), standings: await standingsView(fresh) });
}));

/** The host or the owner corrects a match. Body: any of { player1Wins, player2Wins, draws }. */
router.patch('/drafts/:id/matches/:matchId', wrap(async (req, res) => {
  const s = await sessionByPublicId(req.params.id);
  await requireHostOrOwner(req, s);
  const id = String(req.params.matchId);
  await editResults(s, (results) => {
    const m = results.matches.find((x) => x.id === id);
    if (!m) throw new HttpError(404, 'That match no longer exists');
    const pick = (key, current) => (Object.prototype.hasOwnProperty.call(req.body, key) ? req.body[key] : current);
    return correctMatch(results, id, { w1: pick('player1Wins', m.w1), w2: pick('player2Wins', m.w2), d: pick('draws', m.d) }, { always: true });
  });
  const fresh = await sessionByPublicId(req.params.id);
  await matches.hydrate(pool, [fresh]);
  res.json({ match: await matchById(s, id), standings: await standingsView(fresh) });
}));

router.delete('/drafts/:id/matches/:matchId', wrap(async (req, res) => {
  const s = await sessionByPublicId(req.params.id);
  await requireHostOrOwner(req, s);
  const id = String(req.params.matchId);
  await editResults(s, (results) => {
    if (!results.matches.some((x) => x.id === id)) throw new HttpError(404, 'That match no longer exists');
    return pods.deleteMatch(results, id);
  });
  const fresh = await sessionByPublicId(req.params.id);
  await matches.hydrate(pool, [fresh]);
  res.json({ success: true, standings: await standingsView(fresh) });
}));

router.get('/drafts/:id/standings', wrap(async (req, res) => {
  const s = await sessionByPublicId(req.params.id);
  await matches.hydrate(pool, [s]);
  res.set('Cache-Control', 'no-store');
  const seat = s.status === 'assigned' ? await mySeat(req, s, s.results) : null;
  let me = null;
  if (seat) {
    const d = (await decks.byName(pool, s.id, s.public_id))[seat.name] || {};
    me = { name: seat.name, cubeId: seat.cubeId, deck: { deckName: d.deckName || null, notes: d.notes || null, matchNotes: d.matchNotes || {}, postedAt: d.postedAt || null } };
  }
  res.json({ ...(await standingsView(s)), me, discordPost: webhook.enabled() });
}));

// ---------- draft night: deck photos ----------
// The body is the image itself (JPEG, PNG or WebP), not JSON.

const photoBody = express.raw({ type: () => true, limit: decks.MAX_PHOTO_BYTES });

function readPhoto(req) {
  const mime = decks.sniffImage(req.body);
  if (!mime) throw new HttpError(400, 'The photo must be a JPEG, PNG or WebP image');
  return { data: req.body, mime };
}

async function assignedDraft(s) {
  if (s.status !== 'assigned' || !s.results) throw new HttpError(409, 'Pods are not assigned yet');
  return s;
}

router.get('/drafts/:id/decks/:deckId/photo', wrap(async (req, res) => {
  const s = await sessionByPublicId(req.params.id);
  const deckId = Number(req.params.deckId);
  const { rows } = Number.isInteger(deckId)
    ? await pool.query('SELECT photo_data, photo_mime_type FROM draft_decks WHERE id = $1 AND draft_id = $2 AND photo_data IS NOT NULL', [deckId, s.id])
    : { rows: [] };
  if (!rows[0]) throw new HttpError(404, 'Photo not found');
  // The URL changes whenever the photo does (?v=), so it can be cached for a long time.
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(rows[0].photo_mime_type).send(rows[0].photo_data);
}));

// A player adds or replaces the photo of their own deck.
router.put('/drafts/:id/decks/mine/photo', photoBody, wrap(async (req, res) => {
  const s = await assignedDraft(await sessionByPublicId(req.params.id));
  const { data, mime } = readPhoto(req);
  const seat = await mySeat(req, s, s.results);
  if (!seat) throw new HttpError(403, NOT_SEATED);
  await decks.savePhoto(pool, s.id, seat.name, seat.playerId, data, mime);
  res.json({ success: true });
}));

router.delete('/drafts/:id/decks/mine/photo', wrap(async (req, res) => {
  const s = await assignedDraft(await sessionByPublicId(req.params.id));
  const seat = await mySeat(req, s, s.results);
  if (!seat) throw new HttpError(403, NOT_SEATED);
  await decks.removePhoto(pool, s.id, seat.name);
  res.json({ success: true });
}));

// ---------- draft night: deck reports ----------

/** The caller's seat in an assigned draft, or a 403. */
async function requireSeat(req, s) {
  await assignedDraft(s);
  await matches.hydrate(pool, [s]);
  const seat = await mySeat(req, s, s.results);
  if (!seat) throw new HttpError(403, NOT_SEATED);
  return seat;
}

// A player saves their deck's name and notes. Body: { deckName, notes, matchNotes: { matchId: text } }.
router.put('/drafts/:id/decks/mine', wrap(async (req, res) => {
  const s = await sessionByPublicId(req.params.id);
  const seat = await requireSeat(req, s);
  const deckName = cleanText(req.body.deckName, decks.LIMITS.deckName, 'Deck name');
  const note = (v, label, max) => {
    try { return decks.cleanNote(v, max); } catch (err) { throw new HttpError(400, `${label} ${err.message}`); }
  };
  const notes = note(req.body.notes, 'Notes', decks.LIMITS.notes);
  const mine = new Map(s.results.matches.filter((m) => m.p1 === seat.name || m.p2 === seat.name).map((m) => [m.id, m]));
  const matchNotes = {};
  const input = req.body.matchNotes && typeof req.body.matchNotes === 'object' ? req.body.matchNotes : {};
  for (const [id, text] of Object.entries(input)) {
    const m = mine.get(id);
    if (!m) continue; // a match that was deleted, or someone else's
    const v = note(text, `The note on round ${m.round}`, decks.LIMITS.matchNote);
    if (v) matchNotes[id] = v;
  }
  await decks.saveDetails(pool, s.id, seat.name, seat.playerId, { deckName, notes, matchNotes });
  res.json({ success: true });
}));

/** The deck report text for the caller's seat. */
async function myReport(s, seat) {
  const all = await decks.byName(pool, s.id, s.public_id);
  const pod = s.results.pods.find((p) => p.cubeId === seat.cubeId);
  const deckNames = Object.fromEntries(Object.entries(all).filter(([, d]) => d.deckName).map(([n, d]) => [n, d.deckName]));
  const deck = all[seat.name] || {};
  return { deck, text: decks.reportText({ name: seat.name, cubeName: pod && pod.name, deck, matches: s.results.matches, deckNames }) };
}

router.get('/drafts/:id/decks/mine/report', wrap(async (req, res) => {
  const s = await sessionByPublicId(req.params.id);
  const { deck, text } = await myReport(s, await requireSeat(req, s));
  res.set('Cache-Control', 'no-store');
  res.json({ text, photoUrl: deck.photoUrl || null });
}));

// Posts the caller's deck report to the Discord channel set in DISCORD_WEBHOOK_URL.
router.post('/drafts/:id/decks/mine/post', wrap(async (req, res) => {
  if (!webhook.enabled()) throw new HttpError(403, 'Posting to Discord is not set up on this server');
  const s = await sessionByPublicId(req.params.id);
  const seat = await requireSeat(req, s);
  const { deck, text } = await myReport(s, seat);
  // One post a minute per player, so a double tap doesn't post twice.
  const { rows: [claim] } = await pool.query(
    `INSERT INTO draft_decks (draft_id, player_name, player_id, posted_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (draft_id, lower(player_name)) DO UPDATE SET posted_at = now()
       WHERE draft_decks.posted_at IS NULL OR draft_decks.posted_at < now() - interval '1 minute'
     RETURNING id`,
    [s.id, seat.name, seat.playerId]
  );
  if (!claim) throw new HttpError(429, 'You just posted. Wait a minute before posting again.');

  const { rows: [photo] } = await pool.query('SELECT photo_data AS data, photo_mime_type AS mime FROM draft_decks WHERE id = $1 AND photo_data IS NOT NULL', [claim.id]);
  let avatarUrl = null;
  if (seat.playerId) {
    const { rows: [p] } = await pool.query('SELECT * FROM players WHERE id = $1', [seat.playerId]);
    if (p) avatarUrl = discord.playerDto(p).avatarUrl;
  }
  try {
    await webhook.post({ username: seat.name, avatarUrl, messages: decks.splitMessage(text), photo: photo || null });
  } catch (err) {
    await pool.query('UPDATE draft_decks SET posted_at = $2 WHERE id = $1', [claim.id, deck.postedAt || null]);
    console.error(err.message);
    throw new HttpError(502, err.userMsg || 'Posting to Discord failed');
  }
  res.json({ success: true });
}));

// The host adds or removes a photo for anyone seated, for players who aren't logged in.
async function hostSeatName(s, name) {
  await assignedDraft(s);
  const seated = s.results.pods.some((p) => p.players.some((x) => x.name === name));
  if (!seated) throw new HttpError(404, `${name || 'That player'} is not seated in a pod`);
  const { rows: votes } = await pool.query('SELECT player_name, player_id FROM votes WHERE session_id = $1 AND player_id IS NOT NULL', [s.id]);
  return records.linkedNames(s.results, votes).get(name) ?? null;
}

router.put('/admin/:adminToken/decks/photo', photoBody, wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  const name = String(req.query.name || '');
  const { data, mime } = readPhoto(req);
  const playerId = await hostSeatName(s, name);
  await decks.savePhoto(pool, s.id, name, playerId, data, mime);
  await sendView(req, res);
}));

router.delete('/admin/:adminToken/decks/photo', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  const name = String(req.query.name || '');
  await assignedDraft(s);
  await decks.removePhoto(pool, s.id, name);
  await sendView(req, res);
}));

// Deletes the whole draft: cubes, ballots, pods and match results. Cubes saved in the library are kept.
router.delete('/admin/:adminToken', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  await pool.query('DELETE FROM sessions WHERE id = $1', [s.id]);
  res.json({ success: true });
}));

// ---------- cube library ----------

const savedCubeDto = (c) => ({
  savedId: c.id,
  name: c.name,
  author: c.author,
  url: c.url,
  cardCount: c.card_count,
  minPlayers: c.min_players,
  maxPlayers: c.max_players,
  lastUsedAt: c.last_used_at
});

router.get('/library', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM saved_cubes ORDER BY lower(name), id');
  res.json({ cubes: rows.map(savedCubeDto), canDelete: await owner.isOwner(req) });
}));

// The owner adds a cube straight to the library without making a draft. Adding one that is
// already saved updates its details, the same as saving it from a draft.
router.post('/library', wrap(async (req, res) => {
  await requireOwner(req);
  const cube = await resolveCube({ ...(req.body || {}), save: true }, 0, 'Cube');
  await saveToLibrary(pool, [cube]);
  const { rows } = await pool.query('SELECT * FROM saved_cubes WHERE cubecobra_id = $1', [cube.cubecobraId]);
  res.status(201).json({ cube: savedCubeDto(rows[0]) });
}));

// The owner corrects a saved cube's details. The Cube Cobra link stays the same, since it is what
// identifies the cube. Drafts that already use the cube are not changed.
router.put('/library/:id', wrap(async (req, res) => {
  await requireOwner(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Invalid cube');
  const b = req.body || {};
  const name = cleanText(b.name, 200, 'Cube name', { required: true });
  const author = cleanText(b.author, 100, 'Author');
  const count = b.cardCount === null || b.cardCount === undefined || b.cardCount === '' ? null : Number(b.cardCount);
  if (count !== null && (!Number.isInteger(count) || count < 0 || count > 100000)) throw new HttpError(400, 'Card count must be a whole number');
  const minPlayers = cleanInt(b.minPlayers, 6, 'Minimum players', 1, MAX_PLAYERS_PER_POD);
  const maxPlayers = cleanInt(b.maxPlayers, 8, 'Maximum players', 1, MAX_PLAYERS_PER_POD);
  if (minPlayers > maxPlayers) throw new HttpError(400, 'Minimum players cannot exceed maximum players');
  const { rows } = await pool.query(
    `UPDATE saved_cubes SET name = $2, author = $3, card_count = $4, min_players = $5, max_players = $6
     WHERE id = $1 RETURNING *`,
    [id, name, author, count, minPlayers, maxPlayers]
  );
  if (!rows[0]) throw new HttpError(404, 'That cube is no longer in the library');
  res.json({ cube: savedCubeDto(rows[0]) });
}));

router.delete('/library/:id', wrap(async (req, res) => {
  await requireOwner(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Invalid cube');
  await pool.query('DELETE FROM saved_cubes WHERE id = $1', [id]);
  res.json({ success: true });
}));

// ---------- players and public records ----------

/** Every draft with pods, newest first, with the ballots that are linked to a Discord player. */
async function assignedSessions(db = pool, { ids = null, lock = false } = {}) {
  const { rows } = await db.query(`
    SELECT s.id, s.title, s.public_id, s.team_mode, s.created_at, s.assigned_at, s.results,
      COALESCE((SELECT json_agg(json_build_object('player_name', v.player_name, 'player_id', v.player_id))
        FROM votes v WHERE v.session_id = s.id AND v.player_id IS NOT NULL), '[]') AS votes
    FROM sessions s
    WHERE s.status = 'assigned' AND s.results IS NOT NULL AND ($1::int[] IS NULL OR s.id = ANY($1::int[]))
    ORDER BY COALESCE(s.assigned_at, s.created_at) DESC, s.id DESC
    ${lock ? 'FOR UPDATE OF s' : ''}`, [ids]);
  return matches.hydrate(db, rows);
}

/** Every draft with pods that involves one of these players, as [{ session, entry, playerId }]. */
async function draftEntries(playerId = null) {
  const out = [];
  for (const s of await assignedSessions()) {
    for (const [name, id] of records.linkedNames(s.results, s.votes)) {
      if (playerId !== null && id !== playerId) continue;
      const entry = records.draftEntry(s.results, name, s.team_mode);
      if (entry) out.push({ session: s, entry, playerId: id });
    }
  }
  return out;
}

/**
 * Names that played without a Discord login, grouped across drafts ignoring capitals,
 * as [{ session, entry, key }]. Pass `key` for one name.
 */
async function livePlayerIds(db = pool) {
  const { rows } = await db.query('SELECT id FROM players');
  const ids = new Set(rows.map((r) => r.id));
  return (id) => ids.has(id);
}

async function unclaimedEntries(key = null) {
  const out = [];
  const isLive = await livePlayerIds();
  for (const s of await assignedSessions()) {
    for (const name of records.unlinkedNames(s.results, s.votes, isLive)) {
      const k = records.nameKey(name);
      if (!k || (key !== null && k !== key)) continue;
      const entry = records.draftEntry(s.results, name, s.team_mode);
      if (entry) out.push({ session: s, entry, key: k });
    }
  }
  return out;
}

const draftDto = ({ session: s, entry }) => ({
  sessionId: s.id,
  title: s.title,
  date: s.assigned_at || s.created_at,
  teamMode: s.team_mode,
  ...entry
});

const AUTH_OFF = 'Discord login is turned off on this server';

router.get('/me', wrap(async (req, res) => {
  const p = await discord.currentPlayer(req);
  res.json({ enabled: discord.enabled(), player: p ? discord.playerDto(p) : null });
}));

router.post('/auth/logout', wrap(async (req, res) => {
  await discord.logout(req, res);
  res.json({ success: true });
}));

// Deletes the logged-in player's profile. Their ballots and seats stay in past drafts as plain names.
router.delete('/me', wrap(async (req, res) => {
  if (!discord.enabled()) throw new HttpError(403, AUTH_OFF);
  const p = await discord.currentPlayer(req);
  if (!p) throw new HttpError(401, 'Log in first');
  await pool.query('DELETE FROM players WHERE id = $1', [p.id]);
  await discord.logout(req, res);
  res.json({ success: true });
}));

// Everyone who has logged in, with their lifetime record.
router.get('/players', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM players ORDER BY lower(display_name), id');
  const byPlayer = new Map(rows.map((p) => [p.id, []]));
  for (const { entry, playerId } of await draftEntries()) if (byPlayer.has(playerId)) byPlayer.get(playerId).push(entry);
  const byName = new Map();
  for (const { entry, key } of await unclaimedEntries()) {
    if (!byName.has(key)) byName.set(key, { name: entry.name, entries: [] });
    byName.get(key).entries.push(entry);
  }
  const totals = (entries) => {
    const t = records.summarize(entries);
    delete t.cubes;
    return t;
  };
  res.json({
    players: rows.map((p) => ({ ...discord.playerDto(p), ...totals(byPlayer.get(p.id)) })),
    unclaimed: [...byName.values()]
      .map((u) => ({ name: u.name, ...totals(u.entries) }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  });
}));

// A name that played without logging in. Its drafts can be claimed by a logged-in player.
router.get('/players/name/:name', wrap(async (req, res) => {
  const key = records.nameKey(req.params.name);
  const list = key ? await unclaimedEntries(key) : [];
  if (!list.length) throw new HttpError(404, 'No unclaimed drafts under that name');
  const me = await discord.currentPlayer(req);
  res.json({
    name: list[0].entry.name,
    me: me ? discord.playerDto(me) : null,
    loginEnabled: discord.enabled(),
    totals: records.summarize(list.map((x) => x.entry)),
    drafts: list.map(draftDto)
  });
}));

/**
 * The logged-in player claims the drafts they played under a plain name. Those seats and
 * matches are linked to their account, so they count toward their record. A draft where
 * they are already linked under another name is skipped, since that seat is someone else.
 */
router.post('/players/name/:name/claim', wrap(async (req, res) => {
  if (!discord.enabled()) throw new HttpError(403, AUTH_OFF);
  const me = await discord.currentPlayer(req);
  if (!me) throw new HttpError(401, 'Log in with Discord first');
  const key = records.nameKey(req.params.name);
  const ids = Array.isArray(req.body.sessionIds) ? req.body.sessionIds.map(Number).filter(Number.isInteger) : null;
  if (!key) throw new HttpError(400, 'Invalid name');
  if (ids && !ids.length) throw new HttpError(400, 'Pick at least one draft to claim');

  const client = await pool.connect();
  const claimed = [];
  const skipped = [];
  try {
    await client.query('BEGIN');
    const isLive = await livePlayerIds(client);
    for (const s of await assignedSessions(client, { ids, lock: true })) {
      const name = records.unlinkedNames(s.results, s.votes, isLive).find((n) => records.nameKey(n) === key);
      if (!name || !records.draftEntry(s.results, name, s.team_mode)) continue;
      const linked = records.linkedNames(s.results, s.votes);
      if ([...linked.values()].includes(me.id)) {
        skipped.push(s.title);
        continue;
      }
      const results = { ...s.results, playerIds: { ...(s.results.playerIds || {}), [name]: me.id } };
      await client.query('UPDATE votes SET player_id = $3 WHERE session_id = $1 AND player_name = $2 AND player_id IS NULL', [s.id, name, me.id]);
      await client.query('UPDATE sessions SET results = $2 WHERE id = $1', [s.id, await matches.store(client, s.id, results)]);
      await client.query('UPDATE draft_decks SET player_id = $3 WHERE draft_id = $1 AND player_name = $2', [s.id, name, me.id]);
      claimed.push(s.title);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (!claimed.length && !skipped.length) throw new HttpError(404, 'Those drafts are no longer unclaimed');
  res.json({ claimed, skipped, playerId: me.id });
}));

router.get('/players/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, 'Player not found');
  const { rows } = await pool.query('SELECT * FROM players WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Player not found');
  const me = await discord.currentPlayer(req);
  const list = await draftEntries(id);
  res.json({
    player: { ...discord.playerDto(rows[0]), since: rows[0].created_at },
    isMe: Boolean(me && me.id === id),
    isOwner: await owner.isOwner(req),
    totals: records.summarize(list.map((x) => x.entry)),
    drafts: list.map(draftDto)
  });
}));

/**
 * The owner takes one draft off a player's record, for a wrong claim or a wrong link.
 * Their seat and ballot in that draft become a plain name again, so it can be claimed.
 */
router.post('/players/:id/unlink', wrap(async (req, res) => {
  await requireOwner(req);
  const id = Number(req.params.id);
  const sessionId = Number(req.body.sessionId);
  if (!Number.isInteger(id) || !Number.isInteger(sessionId)) throw new HttpError(400, 'Invalid player or draft');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, results FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    if (!rows[0]) throw new HttpError(404, 'That draft no longer exists');
    await matches.hydrate(client, rows);
    await client.query('UPDATE votes SET player_id = NULL WHERE session_id = $1 AND player_id = $2', [sessionId, id]);
    if (rows[0].results) {
      await client.query('UPDATE sessions SET results = $2 WHERE id = $1', [sessionId, await matches.store(client, sessionId, records.unlinkPlayer(rows[0].results, id))]);
    }
    await client.query('UPDATE draft_decks SET player_id = NULL WHERE draft_id = $1 AND player_id = $2', [sessionId, id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json({ success: true });
}));

// ---------- site owner ----------

const LOGIN_OFF = 'Owner login is turned off. Set OWNER_DISCORD_IDS or ADMIN_PASSWORD on the server to use it.';

router.get('/owner/me', wrap(async (req, res) => {
  const player = await discord.currentPlayer(req);
  res.json({
    enabled: owner.enabled(),
    loggedIn: await owner.isOwner(req),
    discordLogin: owner.discordEnabled(),
    passwordLogin: owner.passwordEnabled(),
    player: player ? discord.playerDto(player) : null
  });
}));

router.post('/owner/login', wrap(async (req, res) => {
  if (!owner.passwordEnabled()) throw new HttpError(403, 'Password login is turned off on this server');
  if (!(await owner.login(req, res, req.body.password))) throw new HttpError(401, 'Wrong password');
  res.json({ success: true });
}));

// Ends both kinds of owner login in this browser, so Log out on the owner page always works.
router.post('/owner/logout', wrap(async (req, res) => {
  await discord.logout(req, res);
  owner.logout(req, res);
  res.json({ success: true });
}));

// Every draft, newest first, with a link to its dashboard. This is the record of past drafts.
router.get('/owner/sessions', wrap(async (req, res) => {
  await requireOwner(req);
  const { rows } = await pool.query(`
    SELECT s.title, s.public_id, s.admin_token, s.status, s.team_mode, s.created_at, s.assigned_at,
      (SELECT count(*)::int FROM votes v WHERE v.session_id = s.id) AS votes,
      (SELECT count(*)::int FROM cubes c WHERE c.session_id = s.id) AS cubes,
      COALESCE(jsonb_array_length(s.results->'pods'), 0) AS pods,
      (SELECT count(*)::int FROM draft_matches m WHERE m.draft_id = s.id AND m.player1_wins IS NOT NULL) AS matches
    FROM sessions s ORDER BY s.created_at DESC, s.id DESC`);
  res.json({
    sessions: rows.map((r) => ({
      title: r.title,
      status: r.status,
      teamMode: r.team_mode,
      createdAt: r.created_at,
      assignedAt: r.assigned_at,
      votes: r.votes,
      cubes: r.cubes,
      pods: r.pods,
      matches: r.matches,
      adminUrl: r.admin_token ? `/admin/${r.admin_token}` : null,
      voteUrl: r.public_id ? `/vote/${r.public_id}` : null
    }))
  });
}));

// ---------- errors ----------

router.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

module.exports = { router };
