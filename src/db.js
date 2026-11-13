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
  `);
}

module.exports = { pool, migrate };
