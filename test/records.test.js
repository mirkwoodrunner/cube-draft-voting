'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { assignPods } = require('../src/borda');
const pods = require('../src/pods');
const records = require('../src/records');

const cube = (id) => ({ id: String(id), name: `Cube ${id}`, minPlayers: 2, maxPlayers: 4 });
const cubes = [cube(1), cube(2)];
const ballots = [
  { name: 'Ann', preferences: [1, 2] },
  { name: 'Bo', preferences: [1, 2] },
  { name: 'Cy', preferences: [2, 1] },
  { name: 'Di', preferences: [2, 1] }
];
const ctx = (teamMode = false) => ({ cubes, preferences: new Map(ballots.map((b) => [b.name, b.preferences])), voterNames: ballots.map((b) => b.name), teamMode });
const base = () => ({ ...assignPods(cubes, ballots), matches: [], playerIds: { Ann: 7 } });

test('linkedNames prefers the assignment map and fills in from ballots', () => {
  const m = records.linkedNames({ playerIds: { Ann: 7 } }, [{ player_name: 'Ann', player_id: 9 }, { player_name: 'Bo', player_id: 8 }, { player_name: 'Cy', player_id: null }]);
  assert.deepStrictEqual([...m], [['Ann', 7], ['Bo', 8]]);
});

test('draftEntry counts matches and games for one player', () => {
  let r = base();
  r = pods.addMatch(r, { cubeId: '1', round: 1, p1: 'Ann', p2: 'Bo', w1: 2, w2: 1 }, false);
  r = pods.addMatch(r, { cubeId: '1', round: 2, p1: 'Bo', p2: 'Ann', w1: 1, w2: 1, d: 1 }, false);
  r = pods.addMatch(r, { cubeId: '1', round: 3, p1: 'Ann', p2: 'Bo' }, false); // unplayed
  const e = records.draftEntry(r, 'Ann', false);
  assert.strictEqual(e.cubeName, 'Cube 1');
  assert.deepStrictEqual([e.w, e.l, e.d, e.gw, e.gl], [1, 0, 1, 3, 2]);
  assert.strictEqual(records.draftEntry(r, 'Nobody', false), null);
});

test('a removed player keeps their played matches and their link', () => {
  let r = base();
  r = pods.addMatch(r, { cubeId: '1', round: 1, p1: 'Ann', p2: 'Bo', w1: 0, w2: 2 }, false);
  r = pods.removePlayer(r, 'Ann', ctx());
  assert.strictEqual(r.playerIds.Ann, 7);
  const e = records.draftEntry(r, 'Ann', false);
  assert.deepStrictEqual([e.w, e.l, e.cubeName], [0, 1, 'Cube 1']);
});

test('rename moves the player link to the new name', () => {
  const r = pods.renamePlayer(base(), 'Ann', 'Annie');
  assert.deepStrictEqual(r.playerIds, { Annie: 7 });
});

test('a late player can be linked once per draft', () => {
  const r = pods.addPlayer(base(), 'Eve', '1', { ...ctx(), playerId: 5, linkedIds: [] });
  assert.strictEqual(r.playerIds.Eve, 5);
  assert.throws(() => pods.addPlayer(r, 'Eve2', '1', { ...ctx(), playerId: 5, linkedIds: [] }), /already in this draft/);
  assert.throws(() => pods.addPlayer(base(), 'Fay', '1', { ...ctx(), playerId: 3, linkedIds: [3] }), /already in this draft/);
});

test('team drafts record the team result', () => {
  let r = pods.setTeamMode(base(), true, () => 0);
  const pod = r.pods.find((p) => p.cubeId === '1');
  const [a, b] = [pod.players.find((p) => p.team === 0).name, pod.players.find((p) => p.team === 1).name];
  r = pods.addMatch(r, { cubeId: '1', round: 1, p1: a, p2: b, w1: 2, w2: 0 }, true);
  assert.strictEqual(records.draftEntry(r, a, true).teamResult, 'won');
  assert.strictEqual(records.draftEntry(r, b, true).teamResult, 'lost');
});

test('summarize totals drafts, matches and cubes', () => {
  const e = (cubeName, w, l, teamResult = null) => ({ cubeName, cubeUrl: null, w, l, d: 0, gw: w * 2, gl: l * 2, teamResult });
  const t = records.summarize([e('Cube 1', 2, 1, 'won'), e('Cube 1', 0, 3), e('Cube 2', 1, 0)]);
  assert.deepStrictEqual([t.drafts, t.w, t.l, t.teamWon], [3, 3, 4, 1]);
  assert.strictEqual(t.matchWinRate, 3 / 7);
  assert.deepStrictEqual(t.cubes.map((c) => [c.name, c.drafts]), [['Cube 1', 2], ['Cube 2', 1]]);
});

test('safeNext only allows same-site paths', () => {
  const { safeNext } = require('../src/discord');
  assert.strictEqual(safeNext('/vote/abc'), '/vote/abc');
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', '', undefined, '/a b']) assert.strictEqual(safeNext(bad), '/', String(bad));
});
