'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { assignPods } = require('../src/borda');
const pods = require('../src/pods');

const cubes = [{ id: '1', name: 'Cube 1', minPlayers: 2, maxPlayers: 8 }];
const names = ['Ann', 'Bo', 'Cy', 'Di'];
const base = () => ({ ...assignPods(cubes, names.map((name) => ({ name, preferences: [1] }))), matches: [] });
const play = (r, round, p1, p2, w1, w2, d = 0) => pods.addMatch(r, { cubeId: '1', round, p1, p2, w1, w2, d }, false);
const row = (st, name) => st['1'].players.find((p) => p.name === name);

test('match points are 3 for a win, 1 for a draw, 0 for a loss', () => {
  let r = base();
  r = play(r, 1, 'Ann', 'Bo', 2, 0);
  r = play(r, 1, 'Cy', 'Di', 1, 1, 1);
  const st = pods.standings(r, false);
  assert.strictEqual(row(st, 'Ann').points, 3);
  assert.strictEqual(row(st, 'Bo').points, 0);
  assert.strictEqual(row(st, 'Cy').points, 1);
  assert.strictEqual(row(st, 'Di').points, 1);
});

test('game win percentage counts a drawn game as 1 of 3 points', () => {
  let r = base();
  r = play(r, 1, 'Ann', 'Bo', 2, 1);
  r = play(r, 2, 'Ann', 'Cy', 1, 1, 1);
  const ann = row(pods.standings(r, false), 'Ann');
  // games: 3 won, 2 lost, 1 drawn. (3*3 + 1) / (3*6)
  assert.strictEqual(ann.gd, 1);
  assert.ok(Math.abs(ann.gwp - 10 / 18) < 1e-12);
  assert.strictEqual(row(pods.standings(r, false), 'Di').gwp, null);
});

test('ties on match points are broken by game win percentage', () => {
  let r = base();
  r = play(r, 1, 'Ann', 'Cy', 2, 1); // Ann 2-1 in games
  r = play(r, 1, 'Bo', 'Di', 2, 0); // Bo 2-0 in games
  const list = pods.standings(r, false)['1'].players;
  assert.deepStrictEqual(list.map((p) => p.name), ['Bo', 'Ann', 'Cy', 'Di']);
  assert.deepStrictEqual(list.map((p) => p.rank), [1, 2, 3, 4]);
});

test('players level on points and GWP share a rank', () => {
  let r = base();
  r = play(r, 1, 'Ann', 'Cy', 2, 0);
  r = play(r, 1, 'Bo', 'Di', 2, 0);
  const list = pods.standings(r, false)['1'].players;
  assert.deepStrictEqual(list.map((p) => [p.name, p.rank]), [['Ann', 1], ['Bo', 1], ['Cy', 3], ['Di', 3]]);
});

test('a 3-0 record with no draws earns a trophy', () => {
  let r = base();
  r = play(r, 1, 'Ann', 'Bo', 2, 0);
  r = play(r, 2, 'Ann', 'Cy', 2, 1);
  r = play(r, 3, 'Di', 'Ann', 0, 2);
  r = play(r, 1, 'Cy', 'Di', 2, 0);
  r = play(r, 2, 'Bo', 'Di', 1, 1, 1);
  r = play(r, 3, 'Bo', 'Cy', 2, 0);
  const st = pods.standings(r, false)['1'];
  assert.deepStrictEqual(st.trophies, ['Ann']);
  assert.strictEqual(row({ 1: st }, 'Ann').trophy, true);
  assert.strictEqual(row({ 1: st }, 'Bo').trophy, false); // 1-1-1
});

test('a 2-0-1 record is not a trophy', () => {
  let r = base();
  r = play(r, 1, 'Ann', 'Bo', 2, 0);
  r = play(r, 2, 'Ann', 'Cy', 2, 0);
  r = play(r, 3, 'Ann', 'Di', 1, 1);
  assert.deepStrictEqual(pods.standings(r, false)['1'].trophies, []);
});

test('updateMatch keeps who reported it and the edited flag', () => {
  let r = base();
  r = play(r, 1, 'Ann', 'Bo', 2, 0);
  r.matches[0].reportedBy = 5;
  r = pods.updateMatch(r, r.matches[0].id, { w1: 2, w2: 1, d: 0 });
  assert.strictEqual(r.matches[0].reportedBy, 5);
});
