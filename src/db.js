'use strict';

const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

const pool = new Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

/**
 * Creates the tables on a fresh database and upgrades tables from the first
 * version of the app in place. Safe to run on every startup.
 */
async function migrate() {
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

    -- sessions: public/admin links and lifecycle
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS public_id TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS admin_token TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS results JSONB;
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_public_id_idx ON sessions(public_id);
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_admin_token_idx ON sessions(admin_token);

    -- cubes: Cube Cobra details
    ALTER TABLE cubes ADD COLUMN IF NOT EXISTS cubecobra_id TEXT;
    ALTER TABLE cubes ADD COLUMN IF NOT EXISTS author TEXT;
    ALTER TABLE cubes ADD COLUMN IF NOT EXISTS card_count INT;
    ALTER TABLE cubes ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]';

    -- votes: edit-token hash, timestamps, case-insensitive one-ballot-per-name
    ALTER TABLE votes ADD COLUMN IF NOT EXISTS token_hash TEXT;
    ALTER TABLE votes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE votes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE UNIQUE INDEX IF NOT EXISTS votes_session_lower_name_idx ON votes(session_id, lower(player_name));

    -- team draft: pods split into two teams that only play each other
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS team_mode BOOLEAN NOT NULL DEFAULT false;

    -- cube library: cubes saved for future sessions
    CREATE TABLE IF NOT EXISTS saved_cubes (
      id SERIAL PRIMARY KEY,
      cubecobra_id TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      name TEXT NOT NULL,
      author TEXT,
      card_count INT,
      min_players INT NOT NULL DEFAULT 6,
      max_players INT NOT NULL DEFAULT 8,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- players who log in with Discord. Their records come from the drafts they played.
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      discord_id TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS player_logins (
      token_hash TEXT PRIMARY KEY,
      player_id INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    ALTER TABLE votes ADD COLUMN IF NOT EXISTS player_id INT REFERENCES players(id) ON DELETE SET NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS votes_session_player_idx ON votes(session_id, player_id) WHERE player_id IS NOT NULL;

    -- draft night: match results. A draft is a row in sessions. Seats are names, so
    -- player1_name / player2_name identify the players. player1_id / player2_id are
    -- the Discord players linked to those names, or null.
    -- player1_wins / player2_wins / draws are all null for a pairing not played yet.
    CREATE TABLE IF NOT EXISTS draft_matches (
      draft_id INT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      seq BIGSERIAL,
      cube_id TEXT NOT NULL,
      round_number INT NOT NULL CHECK (round_number BETWEEN 1 AND 20),
      player1_name TEXT NOT NULL,
      player2_name TEXT NOT NULL,
      player1_id INT REFERENCES players(id) ON DELETE SET NULL,
      player2_id INT REFERENCES players(id) ON DELETE SET NULL,
      player1_wins INT CHECK (player1_wins BETWEEN 0 AND 9),
      player2_wins INT CHECK (player2_wins BETWEEN 0 AND 9),
      draws INT CHECK (draws BETWEEN 0 AND 9),
      reported_by INT REFERENCES players(id) ON DELETE SET NULL,
      edited_by_owner BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (draft_id, id),
      CHECK ((player1_wins IS NULL) = (player2_wins IS NULL) AND (player1_wins IS NULL) = (draws IS NULL))
    );
    CREATE INDEX IF NOT EXISTS draft_matches_player1_idx ON draft_matches(player1_id) WHERE player1_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS draft_matches_player2_idx ON draft_matches(player2_id) WHERE player2_id IS NOT NULL;

    -- Moves matches from the first version (inside sessions.results) into the table, then
    -- removes them from the JSON, so a match deleted later can't come back on a restart.
    INSERT INTO draft_matches (draft_id, id, cube_id, round_number, player1_name, player2_name, player1_id, player2_id,
      player1_wins, player2_wins, draws)
    SELECT s.id, COALESCE(m.v->>'id', md5(s.id || ':' || m.n)), m.v->>'cubeId', (m.v->>'round')::int, m.v->>'p1', m.v->>'p2',
      (SELECT p.id FROM players p WHERE p.id = COALESCE((s.results->'playerIds'->>(m.v->>'p1'))::int,
        (SELECT v.player_id FROM votes v WHERE v.session_id = s.id AND v.player_name = m.v->>'p1'))),
      (SELECT p.id FROM players p WHERE p.id = COALESCE((s.results->'playerIds'->>(m.v->>'p2'))::int,
        (SELECT v.player_id FROM votes v WHERE v.session_id = s.id AND v.player_name = m.v->>'p2'))),
      (m.v->>'w1')::int, (m.v->>'w2')::int,
      CASE WHEN m.v->>'w1' IS NOT NULL THEN COALESCE((m.v->>'d')::int, 0) END
    FROM sessions s, jsonb_array_elements(s.results->'matches') WITH ORDINALITY AS m(v, n)
    WHERE jsonb_typeof(s.results->'matches') = 'array'
    ORDER BY s.id, m.n
    ON CONFLICT (draft_id, id) DO NOTHING;
    UPDATE sessions SET results = results - 'matches' WHERE results ? 'matches';

    -- draft night: each player's deck. archetype_tags is a JSON array of strings.
    -- The photo is stored in the row (photo_data), with its type in photo_mime_type.
    CREATE TABLE IF NOT EXISTS draft_decks (
      id SERIAL PRIMARY KEY,
      draft_id INT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      player_name TEXT NOT NULL,
      player_id INT REFERENCES players(id) ON DELETE SET NULL,
      deck_name TEXT,
      archetype_tags JSONB NOT NULL DEFAULT '[]',
      decklist_url TEXT,
      photo_data BYTEA,
      photo_mime_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((photo_data IS NULL) = (photo_mime_type IS NULL)),
      CHECK (photo_mime_type IS NULL OR photo_mime_type IN ('image/jpeg', 'image/png', 'image/webp'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS draft_decks_draft_name_idx ON draft_decks(draft_id, lower(player_name));
    CREATE INDEX IF NOT EXISTS draft_decks_player_idx ON draft_decks(player_id) WHERE player_id IS NOT NULL;
  `);
}

module.exports = { pool, migrate };
