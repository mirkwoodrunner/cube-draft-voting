'use strict';

const crypto = require('crypto');
const express = require('express');
const { pool } = require('./db');
const { fetchCubeInfo, parseCubeUrl, CubeCobraError } = require('./cubecobra');
const { assignPods } = require('./borda');
const pods = require('./pods');
const owner = require('./owner');

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

async function resolveCube(input, index) {
  const label = `Cube ${index + 1}`;
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
  const cubes = await Promise.all(input.map(resolveCube));
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

function requireOwner(req) {
  if (!owner.enabled()) throw new HttpError(403, LOGIN_OFF);
  if (!owner.isOwner(req)) throw new HttpError(401, 'Log in as the owner first');
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
router.get('/sessions/:sessionId/ballot', wrap(async (req, res) => {
  const s = await sessionByPublicId(req.params.sessionId);
  const token = req.get('x-voter-token');
  if (!token) return res.json({ ballot: null });
  const { rows } = await pool.query(
    'SELECT player_name, preferences FROM votes WHERE session_id = $1 AND token_hash = $2',
    [s.id, sha256(token)]
  );
  res.json({ ballot: rows[0] ? { playerName: rows[0].player_name, preferences: rows[0].preferences } : null });
}));

/**
 * Saves or updates one ballot. `voterToken` is the edit token the caller holds.
 * `insertToken` (admin only) is the token to store when this is a new ballot,
 * instead of issuing a random one.
 */
async function saveBallot(s, playerName, prefs, voterToken, insertToken = null) {
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

    // A browser holding the edit token for an existing ballot updates that ballot (renaming is allowed).
    let issued = null;
    if (voterToken) {
      try {
        const updated = await client.query(
          `UPDATE votes SET player_name = $2, preferences = $3, updated_at = now()
           WHERE session_id = $1 AND token_hash = $4 RETURNING id`,
          [s.id, playerName, prefsJson, sha256(voterToken)]
        );
        if (updated.rowCount) issued = voterToken;
      } catch (err) {
        if (err.code === '23505') throw nameTaken();
        throw err;
      }
    }

    const isUpdate = issued !== null;
    if (!isUpdate) {
      issued = insertToken || newToken(24);
      const inserted = await client.query(
        `INSERT INTO votes (session_id, player_name, preferences, token_hash)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
        [s.id, playerName, prefsJson, sha256(issued)]
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
  res.json(await saveBallot(s, playerName, req.body.preferences, voterToken));
}));

// ---------- admin dashboard ----------

// The admin's own ballot is keyed to their admin token, so no separate player link is needed.
const adminVoterToken = (adminToken) => `admin:${adminToken}`;

async function adminView(s, req) {
  const cubes = await loadCubes(s.id);
  const myHash = sha256(adminVoterToken(s.admin_token));
  const { rows: votes } = await pool.query(
    'SELECT id, player_name, preferences, updated_at, token_hash FROM votes WHERE session_id = $1 ORDER BY created_at, id',
    [s.id]
  );
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
    isOwner: owner.isOwner(req)
  };
}

/** Sends the refreshed dashboard after an admin action. */
const sendView = async (req, res) => res.json(await adminView(await sessionByAdminToken(req.params.adminToken), req));

router.get('/admin/:adminToken', wrap(async (req, res) => {
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
  const { rows: votes } = await pool.query('SELECT player_name, preferences FROM votes WHERE session_id = $1', [s.id]);
  let results = assignPods(cubes, votes.map((v) => ({ name: v.player_name, preferences: v.preferences })));
  results = { ...(s.team_mode ? pods.setTeamMode(results, true) : results), matches: [], computedAt: new Date().toISOString() };

  await pool.query("UPDATE sessions SET results = $2, status = 'assigned', assigned_at = now() WHERE id = $1", [s.id, JSON.stringify(results)]);
  await sendView(req, res);
}));

// Wipes computed pods. Used whenever the cubes or the voter list change after an assignment.
const STALE_RESULTS = "results = NULL, assigned_at = NULL, status = CASE WHEN status = 'assigned' THEN 'closed' ELSE status END";

router.post('/admin/:adminToken/reopen', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  await pool.query(
    "UPDATE sessions SET status = 'open', closed_at = NULL, results = NULL, assigned_at = NULL WHERE id = $1",
    [s.id]
  );
  await sendView(req, res);
}));

router.delete('/admin/:adminToken/voters/:voteId', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  const voteId = Number(req.params.voteId);
  if (!Number.isInteger(voteId)) throw new HttpError(400, 'Invalid voter');
  const del = await pool.query('DELETE FROM votes WHERE id = $1 AND session_id = $2', [voteId, s.id]);
  if (del.rowCount) await pool.query(`UPDATE sessions SET ${STALE_RESULTS} WHERE id = $1`, [s.id]);
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
  res.json({ success: true, updated: out.updated });
}));

// "I'm not playing": removes the admin's ballot if there is one.
router.delete('/admin/:adminToken/ballot', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  const del = await pool.query('DELETE FROM votes WHERE session_id = $1 AND token_hash = $2', [s.id, sha256(adminVoterToken(s.admin_token))]);
  if (del.rowCount) await pool.query(`UPDATE sessions SET ${STALE_RESULTS} WHERE id = $1`, [s.id]);
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
      await client.query(`UPDATE sessions SET ${STALE_RESULTS} WHERE id = $1`, [s.id]);
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
    let next;
    try {
      next = await fn(row.results, row, client);
    } catch (err) {
      if (err instanceof pods.PodError) throw new HttpError(400, err.message);
      throw err;
    }
    await client.query('UPDATE sessions SET results = $2 WHERE id = $1', [s.id, JSON.stringify(next)]);
    await client.query('COMMIT');
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
      const results = rows[0].results ? JSON.stringify(pods.setTeamMode(rows[0].results, on)) : null;
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

router.post('/admin/:adminToken/pods/move', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  const name = String(req.body.name || '');
  const to = req.body.cubeId === null || req.body.cubeId === undefined || req.body.cubeId === '' ? null : String(req.body.cubeId);
  await editResults(s, async (results, row, client) => {
    const cubes = (await loadCubes(s.id, client)).map(cubeDto);
    const { rows: votes } = await client.query('SELECT player_name, preferences FROM votes WHERE session_id = $1', [s.id]);
    const preferences = new Map(votes.map((v) => [v.player_name, v.preferences]));
    return pods.movePlayer(results, name, to, { cubes, preferences, teamMode: row.team_mode });
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
  await editResults(s, (results) => pods.updateMatch(results, req.params.matchId, req.body));
  await sendView(req, res);
}));

router.delete('/admin/:adminToken/matches/:matchId', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  await editResults(s, (results) => pods.deleteMatch(results, req.params.matchId));
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
  res.json({ cubes: rows.map(savedCubeDto), canDelete: owner.isOwner(req) });
}));

router.delete('/library/:id', wrap(async (req, res) => {
  requireOwner(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Invalid cube');
  await pool.query('DELETE FROM saved_cubes WHERE id = $1', [id]);
  res.json({ success: true });
}));

// ---------- site owner ----------

const LOGIN_OFF = 'Owner login is turned off. Set ADMIN_PASSWORD on the server to use it.';

router.get('/owner/me', (req, res) => res.json({ enabled: owner.enabled(), loggedIn: owner.isOwner(req) }));

router.post('/owner/login', wrap(async (req, res) => {
  if (!owner.enabled()) throw new HttpError(403, LOGIN_OFF);
  if (!(await owner.login(req, res, req.body.password))) throw new HttpError(401, 'Wrong password');
  res.json({ success: true });
}));

router.post('/owner/logout', (req, res) => {
  owner.logout(req, res);
  res.json({ success: true });
});

// Every draft, newest first, with a link to its dashboard. This is the record of past drafts.
router.get('/owner/sessions', wrap(async (req, res) => {
  requireOwner(req);
  const { rows } = await pool.query(`
    SELECT s.title, s.public_id, s.admin_token, s.status, s.team_mode, s.created_at, s.assigned_at,
      (SELECT count(*)::int FROM votes v WHERE v.session_id = s.id) AS votes,
      (SELECT count(*)::int FROM cubes c WHERE c.session_id = s.id) AS cubes,
      COALESCE(jsonb_array_length(s.results->'pods'), 0) AS pods,
      (SELECT count(*)::int FROM jsonb_array_elements(COALESCE(s.results->'matches', '[]'::jsonb)) m
        WHERE jsonb_typeof(m->'w1') = 'number') AS matches
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
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

module.exports = { router };
