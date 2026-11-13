'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { assignPods } = require('../src/borda');
const pods = require('../src/pods');

const cube = (id, min, max) => ({ id: String(id), name: `Cube ${id}`, minPlayers: min, maxPlayers: max });
const cubes = [cube(1, 2, 4), cube(2, 2, 4), cube(3, 2, 4)];
const ballots = [
  { name: 'Ann', preferences: [1, 2, 3] },
  { name: 'Bo', preferences: [1, 2, 3] },
  { name: 'Cy', preferences: [2, 1, 3] },
  { name: 'Di', preferences: [2, 1, 3] }
];
const ctx = (teamMode = false) => ({ cubes, preferences: new Map(ballots.map((b) => [b.name, b.preferences])), teamMode });
const base = () => assignPods(cubes, ballots);
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

test('moving a player updates rank, satisfaction and stats', () => {
  const r0 = base();
  const r = pods.movePlayer(r0, 'Ann', '2', ctx());
  const pod2 = r.pods.find((p) => p.cubeId === '2');
  const ann = pod2.players.find((p) => p.name === 'Ann');
  assert.strictEqual(ann.rank, 2);
  assert.strictEqual(ann.satisfaction, 0.5);
  assert.strictEqual(r.stats.seated, 4);
  assert.ok(r.edited);
  assert.ok(r0.pods.find((p) => p.cubeId === '1').players.some((p) => p.name === 'Ann'), 'input is not modified');
});

test('moving into a cube that did not fire creates its pod, and emptying a pod un-fires it', () => {
  let r = pods.movePlayer(base(), 'Ann', '3', ctx());
  assert.ok(r.pods.some((p) => p.cubeId === '3'));
  assert.ok(!r.notFired.some((c) => c.cubeId === '3'));
  r = pods.movePlayer(r, 'Bo', '3', ctx());
  assert.ok(!r.pods.some((p) => p.cubeId === '1'));
  const nf = r.notFired.find((c) => c.cubeId === '1');
  assert.strictEqual(nf.firstChoiceVotes, 2);
});

test('players can be moved out of the pods and back in', () => {
  let r = pods.movePlayer(base(), 'Cy', null, ctx());
  assert.strictEqual(r.unassigned.length, 1);
  assert.strictEqual(r.stats.seated, 3);
  r = pods.movePlayer(r, 'Cy', '1', ctx());
  assert.strictEqual(r.unassigned.length, 0);
  assert.strictEqual(r.pods.find((p) => p.cubeId === '1').players.length, 3);
});

test('team mode splits pods evenly and new arrivals join the smaller team', () => {
  const big = assignPods([cube(1, 2, 8)], ballots);
  const r = pods.setTeamMode(big, true, seq(0.1, 0.7, 0.3));
  const teams = r.pods[0].players.map((p) => p.team);
  assert.deepStrictEqual(teams.filter((t) => t === 0).length, 2);
  assert.deepStrictEqual(teams.filter((t) => t === 1).length, 2);
  const off = pods.setTeamMode(r, false);
  assert.ok(off.pods[0].players.every((p) => p.team === undefined));
});

test('team pairings only cross teams and never repeat', () => {
  const players = ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4'];
  const results = {
    pods: [{ cubeId: '1', players: players.map((name) => ({ name, rank: 1, satisfaction: 1, team: name[0] === 'A' ? 0 : 1 })) }],
    notFired: [], unassigned: [], matches: []
  };
  const r = pods.generateTeamPairings(results, '1', 4);
  assert.strictEqual(r.matches.length, 16);
  const seen = new Set();
  for (const m of r.matches) {
    assert.notStrictEqual(m.p1[0], m.p2[0], 'cross-team only');
    const k = [m.p1, m.p2].sort().join('-');
    assert.ok(!seen.has(k), 'no repeat');
    seen.add(k);
  }
  for (let round = 1; round <= 4; round++) {
    const names = r.matches.filter((m) => m.round === round).flatMap((m) => [m.p1, m.p2]);
    assert.strictEqual(new Set(names).size, 8, 'everyone plays once per round');
  }
});

test('uneven teams give the extra player a bye', () => {
  const results = {
    pods: [{ cubeId: '1', players: ['A1', 'A2', 'B1'].map((name) => ({ name, rank: 1, satisfaction: 1, team: name[0] === 'A' ? 0 : 1 })) }],
    notFired: [], unassigned: [], matches: []
  };
  const r = pods.generateTeamPairings(results, '1', 2);
  assert.strictEqual(r.matches.length, 2);
  assert.ok(r.matches.every((m) => m.p1[0] === 'A' && m.p2 === 'B1'));
});

test('match rules: same pod, different players, cross-team in team mode, one match per round', () => {
  let r = pods.setTeamMode(assignPods([cube(1, 2, 8)], ballots), true, seq(0.1, 0.7, 0.3));
  const [a, b] = [0, 1].map((t) => r.pods[0].players.find((p) => p.team === t).name);
  const mate = r.pods[0].players.find((p) => p.team === 0 && p.name !== a).name;
  assert.throws(() => pods.addMatch(r, { cubeId: '1', round: 1, p1: a, p2: mate }, true), /other team/);
  assert.throws(() => pods.addMatch(r, { cubeId: '1', round: 1, p1: a, p2: a }, true), /different/);
  assert.throws(() => pods.addMatch(r, { cubeId: '1', round: 1, p1: a, p2: b, w1: 2 }, true), /both players/);
  r = pods.addMatch(r, { cubeId: '1', round: 1, p1: a, p2: b, w1: 2, w2: 1 }, true);
  assert.strictEqual(r.matches[0].d, 0);
  assert.throws(() => pods.addMatch(r, { cubeId: '1', round: 1, p1: a, p2: b }, true), /already has a match in round 1/);
  assert.throws(() => pods.generateTeamPairings(r, '1', 1), /already has results/);
});

test('standings count match points, games, and team score', () => {
  let r = pods.setTeamMode(assignPods([cube(1, 2, 8)], ballots), true, seq(0.1, 0.7, 0.3));
  r = pods.generateTeamPairings(r, '1', 2);
  const [m1, m2, m3] = r.matches;
  r = pods.updateMatch(r, m1.id, { w1: 2, w2: 0 });
  r = pods.updateMatch(r, m2.id, { w1: 1, w2: 1, d: 1 });
  r = pods.updateMatch(r, m3.id, { w1: 0, w2: 2 });
  const s = pods.standings(r, true)['1'];
  assert.strictEqual(s.played, 3);
  assert.strictEqual(s.teamScore[0] + s.teamScore[1], 3);
  const winner = s.players.find((p) => p.name === m1.p1);
  assert.strictEqual(winner.points, 3);
  assert.strictEqual(winner.gw, 2);
  const drew = s.players.find((p) => p.name === m2.p1);
  assert.strictEqual(drew.points, 1);
  r = pods.updateMatch(r, m1.id, { w1: '', w2: '' });
  assert.strictEqual(pods.standings(r, true)['1'].played, 2, 'clearing a result makes it unplayed again');
});

test('moving a player drops only their unplayed pairings in the old pod', () => {
  const two = [cube(1, 2, 8), cube(2, 9, 9)];
  let r = pods.setTeamMode(assignPods(two, ballots), true, seq(0.1, 0.7, 0.3));
  r = pods.generateTeamPairings(r, '1', 2);
  const victim = r.matches[0].p1;
  r = pods.updateMatch(r, r.matches[0].id, { w1: 2, w2: 0 });
  r = pods.movePlayer(r, victim, '2', { ...ctx(true), cubes: two });
  assert.strictEqual(r.matches.length, 3, 'other players\'s unplayed pairing stays');
  const left = r.matches.filter((m) => m.p1 === victim || m.p2 === victim);
  assert.strictEqual(left.length, 1, 'the recorded result stays');
  assert.notStrictEqual(left[0].w1, null);
});

test('a late player joins a pod without a ballot and is left out of happiness', () => {
  const r = pods.addPlayer(base(), 'Eve', '1', ctx());
  const eve = r.pods.find((p) => p.cubeId === '1').players.find((p) => p.name === 'Eve');
  assert.deepStrictEqual(eve, { name: 'Eve', rank: null, satisfaction: null, late: true });
  assert.strictEqual(r.stats.seated, 5);
  assert.strictEqual(r.stats.groupSatisfaction, 1, 'late joiner does not drag the score down');
  const moved = pods.movePlayer(r, 'Eve', '2', ctx());
  assert.ok(moved.pods.find((p) => p.cubeId === '2').players.find((p) => p.name === 'Eve').late, 'stays late after a move');
});

test('late player names must be new, ignoring case', () => {
  assert.throws(() => pods.addPlayer(base(), 'ann', '1', ctx()), /already in this draft/);
  assert.throws(() => pods.addPlayer(base(), 'Zed', '1', { ...ctx(), voterNames: ['zed'] }), /already in this draft/);
});

test('late player joins the smaller team', () => {
  let r = pods.setTeamMode(assignPods([cube(1, 2, 8)], ballots.slice(0, 3)), true, seq(0.1, 0.7, 0.3));
  const sizes = [0, 1].map((t) => r.pods[0].players.filter((p) => p.team === t).length);
  r = pods.addPlayer(r, 'Eve', '1', { ...ctx(true), cubes: [cube(1, 2, 8)] });
  assert.strictEqual(r.pods[0].players.find((p) => p.name === 'Eve').team, sizes[0] < sizes[1] ? 0 : 1);
});

test('removing a player keeps other seats and played results, drops their unplayed pairings', () => {
  const one = [cube(1, 2, 8)];
  let r = pods.setTeamMode(assignPods(one, ballots), true, seq(0.1, 0.7, 0.3));
  r = pods.generateTeamPairings(r, '1', 2);
  const gone = r.matches[0].p1;
  r = pods.updateMatch(r, r.matches[0].id, { w1: 2, w2: 0 });
  r = pods.removePlayer(r, gone, { ...ctx(true), cubes: one });
  assert.strictEqual(r.stats.players, 3);
  assert.ok(!r.unassigned.some((u) => u.name === gone));
  const theirs = r.matches.filter((m) => m.p1 === gone || m.p2 === gone);
  assert.strictEqual(theirs.length, 1);
  assert.notStrictEqual(theirs[0].w1, null);
  assert.strictEqual(r.matches.length, 3);
  assert.throws(() => pods.addPlayer(r, gone, '1', { ...ctx(true), cubes: one }), /already in this draft/, 'name with a match record stays reserved');
});

test('renaming updates the seat and every match, and refuses clashes', () => {
  const one = [cube(1, 2, 8)];
  let r = pods.setTeamMode(assignPods(one, ballots), true, seq(0.1, 0.7, 0.3));
  r = pods.generateTeamPairings(r, '1', 2);
  const who = r.matches[0].p1;
  r = pods.updateMatch(r, r.matches[0].id, { w1: 2, w2: 0 });
  const before = r.matches.filter((m) => m.p1 === who || m.p2 === who).length;
  const out = pods.renamePlayer(r, who, 'Zara');
  assert.ok(out.pods[0].players.some((p) => p.name === 'Zara'));
  assert.ok(!out.pods[0].players.some((p) => p.name === who));
  assert.strictEqual(out.matches.filter((m) => m.p1 === 'Zara' || m.p2 === 'Zara').length, before);
  assert.strictEqual(pods.standings(out, true)['1'].players.find((p) => p.name === 'Zara').points, 3);
  const other = r.pods[0].players.find((p) => p.name !== who).name;
  assert.throws(() => pods.renamePlayer(r, who, other.toUpperCase()), /already in this draft/);
  assert.throws(() => pods.renamePlayer(r, who, 'Voter'.toLowerCase(), ['Voter']), /already in this draft/);
  assert.doesNotThrow(() => pods.renamePlayer(r, who, who.toUpperCase()), 'capitals-only change is fine');
});
