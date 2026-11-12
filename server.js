const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());

// Connect to Neon PostgreSQL using the environment variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize Database Tables Automatically on Startup
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS cubes (
        id SERIAL PRIMARY KEY,
        session_id INT REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        url TEXT,
        min_players INT DEFAULT 6,
        max_players INT DEFAULT 8
      );
      CREATE TABLE IF NOT EXISTS votes (
        id SERIAL PRIMARY KEY,
        session_id INT REFERENCES sessions(id) ON DELETE CASCADE,
        player_name TEXT NOT NULL,
        preferences JSONB NOT NULL,
        UNIQUE(session_id, player_name)
      );
    `);
    console.log("Database tables verified/initialized successfully.");
  } catch (err) {
    console.error("Database initialization error:", err);
  }
}
initDB();

// API: Create a Draft Session
app.post('/api/sessions', async (req, res) => {
  const { title, cubes } = req.body; // cubes: [{name, url, minPlayers, maxPlayers}]
  try {
    const sessionResult = await pool.query(
      'INSERT INTO sessions (title) VALUES ($1) RETURNING *',
      [title]
    );
    const sessionId = sessionResult.rows[0].id;

    for (const cube of cubes) {
      await pool.query(
        'INSERT INTO cubes (session_id, name, url, min_players, max_players) VALUES ($1, $2, $3, $4, $5)',
        [sessionId, cube.name, cube.url || '', cube.minPlayers || 6, cube.maxPlayers || 8]
      );
    }

    res.json({ success: true, sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get Session Details (Cubes & Title)
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.id]);
    if (session.rows.length === 0) return res.status(404).json({ error: 'Session not found' });

    const cubes = await pool.query('SELECT * FROM cubes WHERE session_id = $1', [req.params.id]);
    res.json({ session: session.rows[0], cubes: cubes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Submit Ranked Votes
app.post('/api/sessions/:id/vote', async (req, res) => {
  const sessionId = req.params.id;
  const { playerName, preferences } = req.body; // preferences: [cubeId1, cubeId2, ...]
  try {
    await pool.query(
      `INSERT INTO votes (session_id, player_name, preferences) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (session_id, player_name) 
       DO UPDATE SET preferences = $3`,
      [sessionId, playerName, JSON.stringify(preferences)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Run Borda Count Assignment Algorithm & Get Results
app.post('/api/sessions/:id/assign', async (req, res) => {
  const sessionId = req.params.id;
  try {
    const cubesResult = await pool.query('SELECT * FROM cubes WHERE session_id = $1', [sessionId]);
    const votesResult = await pool.query('SELECT * FROM votes WHERE session_id = $1', [sessionId]);

    const cubes = cubesResult.rows.map(c => ({
      id: c.id.toString(),
      name: c.name,
      minPlayers: c.min_players,
      maxPlayers: c.max_players,
      assignedPlayers: []
    }));

    const players = votesResult.rows.map((v, index) => ({
      id: index.toString(),
      name: v.player_name,
      preferences: v.preferences.map(id => id.toString())
    }));

    // Borda Count Weighted Assignment Engine
    const cubeMap = new Map(cubes.map(c => [c.id, c]));
    let preferenceEdges = [];

    for (const player of players) {
      const numPrefs = player.preferences.length;
      player.preferences.forEach((cubeId, index) => {
        const score = numPrefs - index;
        preferenceEdges.push({
          playerId: player.id,
          playerName: player.name,
          cubeId,
          rank: index + 1,
          score
        });
      });
    }

    preferenceEdges.sort((a, b) => b.score - a.score);
    const assignedPlayerIds = new Set();
    const playerAssignments = new Map();

    for (const edge of preferenceEdges) {
      if (assignedPlayerIds.has(edge.playerId)) continue;
      const cube = cubeMap.get(edge.cubeId);
      if (!cube) continue;

      if (cube.assignedPlayers.length < cube.maxPlayers) {
        cube.assignedPlayers.push({
          id: edge.playerId,
          name: edge.playerName,
          rank: edge.rank,
          score: edge.score
        });
        playerAssignments.set(edge.playerId, edge.cubeId);
        assignedPlayerIds.add(edge.playerId);
      }
    }

    const finalPods = {};
    let spilloverPlayers = [];

    for (const player of players) {
      if (!assignedPlayerIds.has(player.id)) {
        spilloverPlayers.push({ name: player.name, reason: 'Unfulfilled preferences' });
      }
    }

    for (const [cubeId, cube] of cubeMap.entries()) {
      if (cube.assignedPlayers.length > 0 && cube.assignedPlayers.length < cube.minPlayers) {
        for (const p of cube.assignedPlayers) {
          spilloverPlayers.push({ name: p.name, reason: `Pod "${cube.name}" dissolved (below min players)` });
        }
      } else if (cube.assignedPlayers.length >= cube.minPlayers) {
        finalPods[cubeId] = {
          cubeName: cube.name,
          minPlayers: cube.minPlayers,
          maxPlayers: cube.maxPlayers,
          players: cube.assignedPlayers
        };
      }
    }

    res.json({ pods: finalPods, spillover: spilloverPlayers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve Simple Mobile-Friendly Frontend UI
app.get('*', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MTG Cube Draft Voting</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen p-4">
  <div class="max-w-md mx-auto bg-slate-800 rounded-xl shadow-lg p-6 mt-6">
    <h1 class="text-2xl font-bold text-center mb-4 text-emerald-450">MTG Cube Draft Voting</h1>
    <p class="text-sm text-slate-400 text-center mb-6">Rank cubes and assign pods automatically.</p>
    <div id="app" class="space-y-4">
      <div class="p-4 bg-slate-700 rounded-lg text-center">
        <p class="mb-2 font-medium">App is live and connected to Neon Postgres!</p>
        <p class="text-xs text-slate-300">Create a session using your API or build out your draft coordinator view here.</p>
      </div>
    </div>
  </div>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
