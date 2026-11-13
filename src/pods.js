'use strict';

/**
 * Edits to a computed pod assignment: moving players, team draft splits,
 * match results and standings. Everything here is pure. Functions take the
 * stored `results` object and return a new one without touching the input.
 *
 * Shapes added on top of what borda.assignPods returns:
 *   pod.players[i].team   0 or 1 (team draft only)
 *   results.matches       [{ id, cubeId, round, p1, p2, w1, w2, d }]
 *                         w1 / w2 / d are null until the result is entered.
 *   results.edited        true once the admin has changed the pods by hand
 *   player.late           true for someone added after voting. They have no
 *                         ballot, so rank and satisfaction are null and they
 *                         are left out of the happiness numbers.
 */

const crypto = require('crypto');

class PodError extends Error {}

const clone = (x) => JSON.parse(JSON.stringify(x));
const lower = (s) => String(s).toLowerCase();
const byName = (a, b) => lower(a.name).localeCompare(lower(b.name));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const newId = () => crypto.randomBytes(6).toString('base64url');

const TEAM_NAMES = ['Team A', 'Team B'];

function rankOf(preferences, cubeId, K) {
  const i = (preferences || []).map(String).indexOf(String(cubeId));
  return i >= 0 ? i + 1 : K;
}
const satisfactionOf = (r, K) => (K > 1 ? (K - r) / (K - 1) : 1);

/** Pod satisfaction and the overall stats block, rebuilt from the pods. */
function recompute(results) {
  const rankCounts = {};
  const rankKey = (p) => (p.rank === null || p.rank === undefined ? Infinity : p.rank);
  const scored = (players) => players.filter((p) => !p.late).map((p) => p.satisfaction);
  for (const pod of results.pods) {
    pod.players.sort((a, b) => (a.team ?? 0) - (b.team ?? 0) || rankKey(a) - rankKey(b) || byName(a, b));
    pod.satisfaction = mean(scored(pod.players));
    for (const p of pod.players) if (!p.late) rankCounts[p.rank] = (rankCounts[p.rank] || 0) + 1;
  }
  const seatedCount = results.pods.reduce((n, p) => n + p.players.length, 0);
  const seated = results.pods.flatMap((p) => scored(p.players));
  results.stats = {
    players: seatedCount + results.unassigned.length,
    seated: seatedCount,
    unassigned: results.unassigned.length,
    groupSatisfaction: mean(seated),
    rankCounts
  };
  return results;
}

/** Random split of one pod into two teams whose sizes differ by at most one. */
function splitTeams(pod, random = Math.random) {
  const order = pod.players.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  order.forEach((idx, pos) => { pod.players[idx].team = pos % 2; });
}

/**
 * Turns team draft on or off for an existing assignment. Turning it on splits
 * every pod at random. Either way, every match is cleared because the old
 * pairings no longer follow the rules.
 */
function setTeamMode(results, on, random = Math.random) {
  const r = clone(results);
  for (const pod of r.pods) {
    if (on) splitTeams(pod, random);
    else pod.players.forEach((p) => { delete p.team; });
  }
  r.matches = [];
  return recompute(r);
}

function findPlayer(r, name) {
  for (const pod of r.pods) {
    const i = pod.players.findIndex((p) => p.name === name);
    if (i >= 0) return { pod, index: i };
  }
  const i = r.unassigned.findIndex((p) => p.name === name);
  if (i >= 0) return { pod: null, index: i };
  throw new PodError(`${name} is not in this draft`);
}

const isPlayed = (m) => m.w1 !== null && m.w1 !== undefined;
const involves = (m, name) => m.p1 === name || m.p2 === name;

/**
 * Moves one player to another cube's pod, or out of the pods when `toCubeId`
 * is null. A cube that did not fire becomes a pod when someone is moved in.
 * A pod left with nobody goes back to the "did not fire" list.
 * Unplayed pairings for the player in their old pod are dropped. Recorded
 * results are kept as history.
 *
 * @param ctx.cubes          session cubes [{ id, name, author, url, minPlayers, maxPlayers }]
 * @param ctx.preferences    Map of player name to their ranked cube ids
 * @param ctx.teamMode       whether the draft is a team draft
 */
function movePlayer(results, name, toCubeId, ctx) {
  const r = clone(results);
  r.matches = r.matches || [];
  const K = ctx.cubes.length;
  const prefs = ctx.preferences.get(name) || [];
  const target = toCubeId === null || toCubeId === undefined ? null : String(toCubeId);

  const from = findPlayer(r, name);
  const fromId = from.pod ? from.pod.cubeId : null;
  const late = Boolean((from.pod ? from.pod.players : r.unassigned)[from.index].late);
  if (fromId === target) return r;

  let targetPod = null;
  if (target !== null) {
    const cube = ctx.cubes.find((c) => String(c.id) === target);
    if (!cube) throw new PodError('That cube is not part of this draft');
    targetPod = r.pods.find((p) => p.cubeId === target);
    if (!targetPod) {
      targetPod = {
        cubeId: target,
        name: cube.name,
        author: cube.author || null,
        url: cube.url || null,
        minPlayers: cube.minPlayers,
        maxPlayers: cube.maxPlayers,
        players: [],
        satisfaction: 0
      };
      r.pods.push(targetPod);
      r.notFired = r.notFired.filter((c) => c.cubeId !== target);
    }
  }

  // Take the player out of where they are now.
  if (from.pod) {
    from.pod.players.splice(from.index, 1);
    r.matches = r.matches.filter((m) => m.cubeId !== fromId || isPlayed(m) || !involves(m, name));
    if (from.pod.players.length === 0) {
      r.pods = r.pods.filter((p) => p !== from.pod);
      const cube = ctx.cubes.find((c) => String(c.id) === fromId) || from.pod;
      r.notFired.push({
        cubeId: fromId,
        name: cube.name,
        author: cube.author || null,
        url: cube.url || null,
        minPlayers: cube.minPlayers,
        maxPlayers: cube.maxPlayers,
        firstChoiceVotes: [...ctx.preferences.values()].filter((p) => p.length && String(p[0]) === fromId).length,
        reason: 'Every player was moved out by the admin'
      });
    }
  } else {
    r.unassigned.splice(from.index, 1);
  }

  if (targetPod) {
    const rank = late ? null : rankOf(prefs, target, K);
    const seat = late ? { name, rank: null, satisfaction: null, late: true } : { name, rank, satisfaction: satisfactionOf(rank, K) };
    if (ctx.teamMode) {
      const sizes = [0, 1].map((t) => targetPod.players.filter((p) => p.team === t).length);
      seat.team = sizes[1] < sizes[0] ? 1 : 0;
    }
    targetPod.players.push(seat);
  } else {
    r.unassigned.push({ name, reason: 'Moved out of the pods by the admin', ...(late ? { late: true } : {}) });
    r.unassigned.sort(byName);
  }

  r.edited = true;
  return recompute(r);
}

const allNames = (r) => [...r.pods.flatMap((p) => p.players), ...r.unassigned].map((p) => p.name);

/**
 * Adds someone who did not vote, straight into a pod (or the unassigned list
 * when `toCubeId` is null). `ctx.voterNames` are names already taken by ballots.
 */
function addPlayer(results, name, toCubeId, ctx) {
  const r = clone(results);
  // Names in old match results count too, so a newcomer never inherits someone else's record.
  const matchNames = (r.matches || []).flatMap((m) => [m.p1, m.p2]);
  const taken = new Set([...allNames(r), ...(ctx.voterNames || []), ...matchNames].map(lower));
  if (taken.has(lower(name))) throw new PodError(`${name} is already in this draft`);
  r.unassigned.push({ name, late: true, reason: 'Joined after voting' });
  r.edited = true;
  if (toCubeId === null || toCubeId === undefined) return recompute(r);
  return movePlayer(r, name, toCubeId, ctx);
}

/**
 * Takes a player out of the draft entirely. Their unplayed pairings go.
 * Results they already played are kept as history.
 */
function removePlayer(results, name, ctx) {
  const r = movePlayer(results, name, null, ctx);
  r.unassigned = r.unassigned.filter((p) => p.name !== name);
  r.matches = (r.matches || []).filter((m) => isPlayed(m) || !involves(m, name));
  r.edited = true;
  return recompute(r);
}

/** Moves a player to the other team in their pod. Their unplayed pairings in that pod are dropped. */
function switchTeam(results, name) {
  const r = clone(results);
  const { pod, index } = findPlayer(r, name);
  if (!pod) throw new PodError(`${name} is not in a pod`);
  const p = pod.players[index];
  p.team = p.team === 1 ? 0 : 1;
  r.matches = (r.matches || []).filter((m) => m.cubeId !== pod.cubeId || isPlayed(m) || !involves(m, name));
  r.edited = true;
  return recompute(r);
}

// ---------- matches ----------

function cleanScore(v, label) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 9) throw new PodError(`${label} must be a whole number from 0 to 9`);
  return n;
}

/** Either all three of w1, w2, d are set, or none are (an unplayed pairing). Blank draws count as 0. */
function cleanResult(input) {
  const w1 = cleanScore(input.w1, 'Games won');
  const w2 = cleanScore(input.w2, 'Games won');
  let d = cleanScore(input.d, 'Draws');
  if (w1 === null && w2 === null) {
    if (d) throw new PodError('Enter games won for both players');
    return { w1: null, w2: null, d: null };
  }
  if (w1 === null || w2 === null) throw new PodError('Enter games won for both players');
  if (d === null) d = 0;
  return { w1, w2, d };
}

function podOf(r, cubeId) {
  const pod = r.pods.find((p) => p.cubeId === String(cubeId));
  if (!pod) throw new PodError('That pod does not exist');
  return pod;
}

function checkPairing(pod, p1, p2, teamMode) {
  const a = pod.players.find((p) => p.name === p1);
  const b = pod.players.find((p) => p.name === p2);
  if (!a || !b) throw new PodError('Both players must be in this pod');
  if (a === b) throw new PodError('Pick two different players');
  if (teamMode && a.team === b.team) throw new PodError('In a team draft, players only play against the other team');
}

function addMatch(results, input, teamMode) {
  const r = clone(results);
  r.matches = r.matches || [];
  const pod = podOf(r, input.cubeId);
  const p1 = String(input.p1 || '');
  const p2 = String(input.p2 || '');
  checkPairing(pod, p1, p2, teamMode);
  const round = Number(input.round);
  if (!Number.isInteger(round) || round < 1 || round > 20) throw new PodError('Round must be a whole number from 1 to 20');
  const busy = r.matches.find((m) => m.cubeId === pod.cubeId && m.round === round && (involves(m, p1) || involves(m, p2)));
  if (busy) throw new PodError(`${involves(busy, p1) ? p1 : p2} already has a match in round ${round}`);
  r.matches.push({ id: newId(), cubeId: pod.cubeId, round, p1, p2, ...cleanResult(input) });
  return r;
}

function updateMatch(results, id, input) {
  const r = clone(results);
  const m = (r.matches || []).find((x) => x.id === id);
  if (!m) throw new PodError('That match no longer exists');
  Object.assign(m, cleanResult(input));
  return r;
}

function deleteMatch(results, id) {
  const r = clone(results);
  r.matches = (r.matches || []).filter((m) => m.id !== id);
  return r;
}

/**
 * Cross-team pairings for a team draft pod. Round k pairs A[i] with
 * B[(i + k) mod n], so nobody meets the same opponent twice. When the teams
 * are uneven, the extra player on the bigger team sits out one round.
 * Replaces unplayed pairings. Refuses once any result in the pod is recorded.
 */
function generateTeamPairings(results, cubeId, rounds) {
  const r = clone(results);
  r.matches = r.matches || [];
  const pod = podOf(r, cubeId);
  if (r.matches.some((m) => m.cubeId === pod.cubeId && isPlayed(m))) {
    throw new PodError('This pod already has results. Add any more pairings by hand.');
  }
  const A = pod.players.filter((p) => p.team === 0).map((p) => p.name);
  const B = pod.players.filter((p) => p.team === 1).map((p) => p.name);
  if (!A.length || !B.length) throw new PodError('Both teams need at least one player');
  const n = Math.max(A.length, B.length);
  const count = Number(rounds);
  if (!Number.isInteger(count) || count < 1 || count > n) throw new PodError(`Rounds must be a whole number from 1 to ${n}`);

  const [big, small, bigIsA] = A.length >= B.length ? [A, B, true] : [B, A, false];
  r.matches = r.matches.filter((m) => m.cubeId !== pod.cubeId);
  for (let k = 0; k < count; k++) {
    for (let i = 0; i < n; i++) {
      const x = big[i];
      const y = small[(i + k) % n];
      if (x === undefined || y === undefined) continue; // bye
      const [p1, p2] = bigIsA ? [x, y] : [y, x];
      r.matches.push({ id: newId(), cubeId: pod.cubeId, round: k + 1, p1, p2, w1: null, w2: null, d: null });
    }
  }
  return r;
}

/**
 * Standings per pod, for display. Match points are 3 for a win, 1 for a draw.
 * In a team draft the team score is match wins, with a drawn match worth half.
 */
function standings(results, teamMode) {
  const out = {};
  for (const pod of results.pods) {
    const rows = new Map(pod.players.map((p) => [p.name, { name: p.name, team: p.team ?? null, w: 0, l: 0, d: 0, gw: 0, gl: 0, points: 0 }]));
    const team = [0, 0];
    const matches = (results.matches || []).filter((m) => m.cubeId === pod.cubeId && isPlayed(m));
    for (const m of matches) {
      const outcome = m.w1 > m.w2 ? 1 : m.w1 < m.w2 ? 2 : 0;
      for (const [me, gw, gl, won] of [[m.p1, m.w1, m.w2, outcome === 1], [m.p2, m.w2, m.w1, outcome === 2]]) {
        const row = rows.get(me);
        if (!row) continue; // player has since left the pod
        row.gw += gw;
        row.gl += gl;
        if (outcome === 0) { row.d += 1; row.points += 1; } else if (won) { row.w += 1; row.points += 3; } else row.l += 1;
      }
      if (teamMode) {
        const t1 = rows.get(m.p1)?.team;
        const t2 = rows.get(m.p2)?.team;
        if (outcome === 1 && t1 !== null && t1 !== undefined) team[t1] += 1;
        else if (outcome === 2 && t2 !== null && t2 !== undefined) team[t2] += 1;
        else if (outcome === 0) {
          if (t1 !== null && t1 !== undefined) team[t1] += 0.5;
          if (t2 !== null && t2 !== undefined) team[t2] += 0.5;
        }
      }
    }
    const list = [...rows.values()].sort((a, b) => b.points - a.points || (b.gw - b.gl) - (a.gw - a.gl) || byName(a, b));
    out[pod.cubeId] = { players: list, played: matches.length, teamScore: teamMode ? team : null };
  }
  return out;
}

module.exports = {
  PodError,
  TEAM_NAMES,
  recompute,
  splitTeams,
  setTeamMode,
  movePlayer,
  addPlayer,
  removePlayer,
  switchTeam,
  addMatch,
  updateMatch,
  deleteMatch,
  generateTeamPairings,
  standings
};
