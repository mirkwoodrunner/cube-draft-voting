'use strict';

/**
 * Player records across drafts. Pure functions over the stored `results` of
 * each draft. Nothing is copied into another table, so a record is always in
 * step with the pods and match results the admin sees.
 */

const pods = require('./pods');

const isPlayed = (m) => m.w1 !== null && m.w1 !== undefined;

/**
 * Which names in a draft belong to which Discord player. The assignment keeps
 * its own map so a player who was removed still owns their played matches.
 * Ballots fill in anyone the map doesn't have.
 */
function linkedNames(results, votes) {
  const out = new Map();
  for (const [name, id] of Object.entries((results && results.playerIds) || {})) out.set(name, Number(id));
  for (const v of votes || []) {
    if (v.player_id !== null && v.player_id !== undefined && !out.has(v.player_name)) out.set(v.player_name, Number(v.player_id));
  }
  return out;
}

/**
 * One player's part in one draft, or null if they never sat in a pod or
 * played a match there. `teamResult` is 'won', 'lost' or 'tied' for a team
 * draft pod with recorded results, otherwise null.
 */
function draftEntry(results, name, teamMode) {
  if (!results) return null;
  const seatPod = results.pods.find((p) => p.players.some((x) => x.name === name));
  const seat = seatPod ? seatPod.players.find((x) => x.name === name) : null;
  const played = (results.matches || []).filter((m) => isPlayed(m) && (m.p1 === name || m.p2 === name));
  if (!seat && !played.length) return null;

  const cubeId = seatPod ? seatPod.cubeId : played[0].cubeId;
  const cube = seatPod || results.pods.find((p) => p.cubeId === cubeId) || (results.notFired || []).find((c) => c.cubeId === cubeId) || {};
  const e = { name, cubeId, cubeName: cube.name || 'Removed cube', cubeUrl: cube.url || null, team: seat && seat.team !== undefined ? seat.team : null, w: 0, l: 0, d: 0, gw: 0, gl: 0, teamResult: null };
  for (const m of played) {
    const [mine, theirs] = m.p1 === name ? [m.w1, m.w2] : [m.w2, m.w1];
    e.gw += mine;
    e.gl += theirs;
    if (mine > theirs) e.w += 1; else if (mine < theirs) e.l += 1; else e.d += 1;
  }
  if (teamMode && seatPod && e.team !== null) {
    const st = pods.standings(results, true)[seatPod.cubeId];
    if (st && st.played && st.teamScore) {
      const [mine, theirs] = [st.teamScore[e.team], st.teamScore[e.team === 1 ? 0 : 1]];
      e.teamResult = mine > theirs ? 'won' : mine < theirs ? 'lost' : 'tied';
    }
  }
  return e;
}

/** Totals over a list of draft entries. */
function summarize(entries) {
  const t = { drafts: entries.length, w: 0, l: 0, d: 0, gw: 0, gl: 0, teamWon: 0, teamLost: 0, teamTied: 0 };
  const cubes = new Map();
  for (const e of entries) {
    for (const k of ['w', 'l', 'd', 'gw', 'gl']) t[k] += e[k];
    if (e.teamResult === 'won') t.teamWon += 1;
    if (e.teamResult === 'lost') t.teamLost += 1;
    if (e.teamResult === 'tied') t.teamTied += 1;
    const key = e.cubeName.toLowerCase();
    const c = cubes.get(key) || { name: e.cubeName, url: e.cubeUrl, drafts: 0 };
    c.drafts += 1;
    cubes.set(key, c);
  }
  const matches = t.w + t.l + t.d;
  t.matchWinRate = matches ? t.w / matches : null;
  t.cubes = [...cubes.values()].sort((a, b) => b.drafts - a.drafts || a.name.localeCompare(b.name));
  return t;
}

module.exports = { linkedNames, draftEntry, summarize };
