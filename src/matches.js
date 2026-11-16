'use strict';

/**
 * Match results live in the draft_matches table. The rest of the app works on
 * them in the same shape they had inside `sessions.results`:
 *   { id, cubeId, round, p1, p2, w1, w2, d, p1Id, p2Id, reportedBy, editedByOwner }
 * so the pure functions in pods.js and records.js don't need to know where they
 * are stored. `hydrate` puts them onto the results it loads, and `store` writes
 * them back and returns the results JSON without them.
 *
 * Seats are names, so p1 / p2 are what identify a player in a match. p1Id / p2Id
 * are the Discord players linked to those names, refreshed on every save.
 */

const records = require('./records');

const toMatch = (r) => ({
  id: r.id,
  cubeId: r.cube_id,
  round: r.round_number,
  p1: r.player1_name,
  p2: r.player2_name,
  w1: r.player1_wins,
  w2: r.player2_wins,
  d: r.draws,
  p1Id: r.player1_id,
  p2Id: r.player2_id,
  reportedBy: r.reported_by,
  editedByOwner: r.edited_by_owner
});

/** Map of session id to its matches, in the order they were added. */
async function load(db, sessionIds) {
  const out = new Map(sessionIds.map((id) => [id, []]));
  if (!sessionIds.length) return out;
  const { rows } = await db.query(
    'SELECT * FROM draft_matches WHERE draft_id = ANY($1::int[]) ORDER BY draft_id, seq',
    [sessionIds]
  );
  for (const r of rows) out.get(r.draft_id).push(toMatch(r));
  return out;
}

/** Sets `results.matches` on every row that has results. Changes the rows in place and returns them. */
async function hydrate(db, rows) {
  const withResults = rows.filter((r) => r && r.results);
  const byId = await load(db, withResults.map((r) => r.id));
  for (const r of withResults) r.results = { ...r.results, matches: byId.get(r.id) };
  return rows;
}

/**
 * Makes the table hold exactly `results.matches` for this draft and returns the
 * results JSON to store on the session, without the matches.
 */
async function store(db, sessionId, results) {
  const matches = (results && results.matches) || [];
  const { rows: votes } = await db.query(
    'SELECT player_name, player_id FROM votes WHERE session_id = $1 AND player_id IS NOT NULL',
    [sessionId]
  );
  const linked = records.linkedNames(results, votes);
  const idOf = (name) => (linked.has(name) ? linked.get(name) : null);

  await db.query('DELETE FROM draft_matches WHERE draft_id = $1 AND NOT (id = ANY($2::text[]))', [sessionId, matches.map((m) => m.id)]);
  if (matches.length) {
    const payload = matches.map((m) => ({
      id: m.id,
      cube_id: m.cubeId,
      round_number: m.round,
      player1_name: m.p1,
      player2_name: m.p2,
      player1_id: idOf(m.p1),
      player2_id: idOf(m.p2),
      player1_wins: m.w1 ?? null,
      player2_wins: m.w2 ?? null,
      draws: m.d ?? null,
      reported_by: m.reportedBy ?? null,
      edited_by_owner: m.editedByOwner === true
    }));
    // Player ids are checked against players, since a linked profile may have been deleted.
    await db.query(`
      INSERT INTO draft_matches AS dm (draft_id, id, cube_id, round_number, player1_name, player2_name, player1_id, player2_id,
        player1_wins, player2_wins, draws, reported_by, edited_by_owner)
      SELECT $1, x.id, x.cube_id, x.round_number, x.player1_name, x.player2_name,
        (SELECT p.id FROM players p WHERE p.id = x.player1_id),
        (SELECT p.id FROM players p WHERE p.id = x.player2_id),
        x.player1_wins, x.player2_wins, x.draws,
        (SELECT p.id FROM players p WHERE p.id = x.reported_by),
        x.edited_by_owner
      FROM jsonb_to_recordset($2::jsonb) AS x(id text, cube_id text, round_number int, player1_name text, player2_name text,
        player1_id int, player2_id int, player1_wins int, player2_wins int, draws int, reported_by int, edited_by_owner boolean)
      ON CONFLICT (draft_id, id) DO UPDATE SET
        cube_id = EXCLUDED.cube_id, round_number = EXCLUDED.round_number,
        player1_name = EXCLUDED.player1_name, player2_name = EXCLUDED.player2_name,
        player1_id = EXCLUDED.player1_id, player2_id = EXCLUDED.player2_id,
        player1_wins = EXCLUDED.player1_wins, player2_wins = EXCLUDED.player2_wins, draws = EXCLUDED.draws,
        reported_by = EXCLUDED.reported_by, edited_by_owner = EXCLUDED.edited_by_owner, updated_at = now()
      WHERE (dm.cube_id, dm.round_number, dm.player1_name, dm.player2_name, dm.player1_id, dm.player2_id,
             dm.player1_wins, dm.player2_wins, dm.draws, dm.reported_by, dm.edited_by_owner)
        IS DISTINCT FROM (EXCLUDED.cube_id, EXCLUDED.round_number, EXCLUDED.player1_name, EXCLUDED.player2_name,
             EXCLUDED.player1_id, EXCLUDED.player2_id, EXCLUDED.player1_wins, EXCLUDED.player2_wins, EXCLUDED.draws,
             EXCLUDED.reported_by, EXCLUDED.edited_by_owner)`,
    [sessionId, JSON.stringify(payload)]);
  }
  if (!results) return null;
  const { matches: _omit, ...rest } = results;
  return JSON.stringify(rest);
}

/** Deletes every match in a draft. Used whenever its pods are cleared or replaced. */
async function clear(db, sessionId) {
  await db.query('DELETE FROM draft_matches WHERE draft_id = $1', [sessionId]);
}

/** The draft_matches row for one match, as the API returns it. */
const dto = (m) => ({
  id: m.id,
  cubeId: m.cubeId,
  roundNumber: m.round,
  player1: m.p1,
  player2: m.p2,
  player1Id: m.p1Id ?? null,
  player2Id: m.p2Id ?? null,
  player1Wins: m.w1,
  player2Wins: m.w2,
  draws: m.d,
  reportedBy: m.reportedBy ?? null,
  editedByOwner: m.editedByOwner === true
});

module.exports = { load, hydrate, store, clear, dto };
