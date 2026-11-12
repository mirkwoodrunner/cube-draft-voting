'use strict';

const crypto = require('crypto');
const express = require('express');
const { pool } = require('./db');
const { fetchCubeInfo, parseCubeUrl, CubeCobraError } = require('./cubecobra');
const { assignPods } = require('./borda');

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
  tags: c.tags || [],
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
      cardCount: Number.isInteger(count) && count >= 0 && count <= 100000 ? count : null,
      tags: (Array.isArray(input.tags) ? input.tags : [])
        .map((t) => cleanText(t, 60, `${label} tag`))
        .filter(Boolean)
        .slice(0, 30)
    };
  } else {
    try {
      info = await fetchCubeInfo(input.url);
    } catch (err) {
      if (err instanceof CubeCobraError) throw new HttpError(422, `${label}: ${err.message}`);
      throw err;
    }
  }
  return { ...info, cubecobraId: parsed.id, url: parsed.url, minPlayers, maxPlayers };
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
  const input = req.body.cubes;
  if (!Array.isArray(input) || input.length < 1) throw new HttpError(400, 'Add at least one cube');
  if (input.length > MAX_CUBES) throw new HttpError(400, `A session can have at most ${MAX_CUBES} cubes`);

  const cubes = await Promise.all(input.map(resolveCube));
  const seen = new Set();
  for (const c of cubes) {
    if (seen.has(c.cubecobraId)) throw new HttpError(400, `The cube "${c.name}" was added more than once`);
    seen.add(c.cubecobraId);
  }

  const publicId = newToken(8);
  const adminToken = newToken(24);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO sessions (title, public_id, admin_token) VALUES ($1, $2, $3) RETURNING id',
      [title, publicId, adminToken]
    );
    for (const c of cubes) {
      await client.query(
        `INSERT INTO cubes (session_id, name, url, cubecobra_id, author, card_count, tags, min_players, max_players)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [rows[0].id, c.name, c.url, c.cubecobraId, c.author, c.cardCount, JSON.stringify(c.tags), c.minPlayers, c.maxPlayers]
      );
    }
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
    session: { id: s.public_id, title: s.title, status: s.status },
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

router.post('/sessions/:sessionId/vote', wrap(async (req, res) => {
  const playerName = cleanText(req.body.playerName, 40, 'Name', { required: true });
  const prefs = req.body.preferences;
  const voterToken = typeof req.body.voterToken === 'string' ? req.body.voterToken : null;

  const s = await sessionByPublicId(req.params.sessionId);
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
    // Holds off a concurrent "Close Voting" until this ballot is saved.
    const { rows: st } = await client.query('SELECT status FROM sessions WHERE id = $1 FOR SHARE', [s.id]);
    if (st[0].status !== 'open') throw new HttpError(403, 'Voting is closed for this session', 'closed');

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
      issued = newToken(24);
      const inserted = await client.query(
        `INSERT INTO votes (session_id, player_name, preferences, token_hash)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
        [s.id, playerName, prefsJson, sha256(issued)]
      );
      if (!inserted.rowCount) throw nameTaken();
    }
    await client.query('COMMIT');
    res.json({ success: true, voterToken: issued, updated: isUpdate });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// ---------- admin dashboard ----------

async function adminView(s) {
  const cubes = await loadCubes(s.id);
  const { rows: votes } = await pool.query(
    'SELECT player_name, updated_at FROM votes WHERE session_id = $1 ORDER BY created_at, id',
    [s.id]
  );
  return {
    session: {
      id: s.public_id,
      title: s.title,
      status: s.status,
      createdAt: s.created_at,
      closedAt: s.closed_at,
      assignedAt: s.assigned_at
    },
    cubes: cubes.map(cubeDto),
    voteCount: votes.length,
    voters: votes.map((v) => ({ name: v.player_name, updatedAt: v.updated_at })),
    results: s.results || null
  };
}

router.get('/admin/:adminToken', wrap(async (req, res) => {
  res.json(await adminView(await sessionByAdminToken(req.params.adminToken)));
}));

router.post('/admin/:adminToken/close', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  if (s.status === 'open') {
    await pool.query("UPDATE sessions SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'open'", [s.id]);
  }
  res.json(await adminView(await sessionByAdminToken(req.params.adminToken)));
}));

router.post('/admin/:adminToken/assign', wrap(async (req, res) => {
  const s = await sessionByAdminToken(req.params.adminToken);
  if (s.status === 'open') throw new HttpError(409, 'Close voting before running the assignment');

  const cubes = (await loadCubes(s.id)).map((c) => ({
    id: String(c.id), name: c.name, author: c.author, url: c.url,
    minPlayers: c.min_players, maxPlayers: c.max_players
  }));
  const { rows: votes } = await pool.query('SELECT player_name, preferences FROM votes WHERE session_id = $1', [s.id]);
  const results = {
    ...assignPods(cubes, votes.map((v) => ({ name: v.player_name, preferences: v.preferences }))),
    computedAt: new Date().toISOString()
  };

  await pool.query("UPDATE sessions SET results = $2, status = 'assigned', assigned_at = now() WHERE id = $1", [s.id, JSON.stringify(results)]);
  res.json(await adminView(await sessionByAdminToken(req.params.adminToken)));
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
