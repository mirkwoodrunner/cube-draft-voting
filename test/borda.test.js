'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { assignPods } = require('../src/borda');

const cube = (id, min, max) => ({ id: String(id), name: `Cube ${id}`, minPlayers: min, maxPlayers: max });
const players = (n, prefsFor) => Array.from({ length: n }, (_, i) => ({ name: `P${String(i).padStart(2, '0')}`, preferences: prefsFor(i) }));

function checkInvariants(result, cubes, numPlayers) {
  for (const pod of result.pods) {
    assert.ok(pod.players.length >= pod.minPlayers, `${pod.name} below min`);
    assert.ok(pod.players.length <= pod.maxPlayers, `${pod.name} above max`);
  }
  assert.strictEqual(result.stats.seated + result.stats.unassigned, numPlayers);
  const names = [...result.pods.flatMap((p) => p.players.map((m) => m.name)), ...result.unassigned.map((u) => u.name)];
  assert.strictEqual(new Set(names).size, numPlayers, 'every player appears exactly once');
}

test('everyone gets their first choice when it fits', () => {
  const cubes = [cube(1, 2, 4), cube(2, 2, 4)];
  const ps = players(6, (i) => (i < 3 ? [1, 2] : [2, 1]));
  const r = assignPods(cubes, ps);
  checkInvariants(r, cubes, 6);
  assert.strictEqual(r.pods.length, 2);
  assert.strictEqual(r.stats.groupSatisfaction, 1);
  assert.strictEqual(r.unassigned.length, 0);
});

test('a cube that cannot reach its minimum is dissolved and its voters re-routed, not stranded', () => {
  // 9 players. Cube 3 is the favorite of 3 players but needs 6. Cubes 1 and 2 need 4-6 each.
  const cubes = [cube(1, 4, 6), cube(2, 4, 6), cube(3, 6, 8)];
  const ps = players(9, (i) => (i < 3 ? [3, 1, 2] : i < 6 ? [1, 2, 3] : [2, 1, 3]));
  const r = assignPods(cubes, ps);
  checkInvariants(r, cubes, 9);
  assert.strictEqual(r.unassigned.length, 0, 'nobody is left out');
  assert.deepStrictEqual(r.pods.map((p) => p.cubeId), ['1', '2']);
  assert.strictEqual(r.notFired[0].cubeId, '3');
  assert.strictEqual(r.notFired[0].firstChoiceVotes, 3);
});

test('too few players for any pod leaves everyone unassigned', () => {
  const r = assignPods([cube(1, 6, 8)], players(4, () => [1]));
  assert.strictEqual(r.pods.length, 0);
  assert.strictEqual(r.unassigned.length, 4);
  assert.match(r.notFired[0].reason, /below this cube's minimum/);
});

test('overflow beyond total capacity is unassigned, and pods stay within max', () => {
  const cubes = [cube(1, 4, 6), cube(2, 4, 6)];
  const r = assignPods(cubes, players(15, () => [1, 2]));
  checkInvariants(r, cubes, 15);
  assert.strictEqual(r.stats.seated, 12);
  assert.strictEqual(r.unassigned.length, 3);
});

test('seats as many players as possible even when that means a less-liked pod', () => {
  // 8 players all love cube 1 (max 4). Cube 2 (min 4) must fire to seat the other 4.
  const cubes = [cube(1, 4, 4), cube(2, 4, 8)];
  const r = assignPods(cubes, players(8, () => [1, 2]));
  checkInvariants(r, cubes, 8);
  assert.strictEqual(r.unassigned.length, 0);
  assert.strictEqual(r.pods.length, 2);
});

test('Borda points decide who gets the contested seats', () => {
  // Cube 1 has 2 seats. A and B rank it first. C ranks it last of three.
  const cubes = [cube(1, 2, 2), cube(2, 1, 5), cube(3, 1, 5)];
  const ps = [
    { name: 'A', preferences: [1, 2, 3] },
    { name: 'B', preferences: [1, 3, 2] },
    { name: 'C', preferences: [2, 3, 1] }
  ];
  const r = assignPods(cubes, ps);
  const pod1 = r.pods.find((p) => p.cubeId === '1');
  assert.deepStrictEqual(pod1.players.map((p) => p.name).sort(), ['A', 'B']);
});

test('is deterministic', () => {
  const cubes = [cube(1, 3, 5), cube(2, 3, 5), cube(3, 3, 5)];
  const ps = players(11, (i) => [[1, 2, 3], [2, 3, 1], [3, 1, 2]][i % 3]);
  assert.deepStrictEqual(assignPods(cubes, ps), assignPods(cubes, [...ps].reverse()));
});

test('handles no votes and a single cube', () => {
  assert.strictEqual(assignPods([cube(1, 2, 4)], []).pods.length, 0);
  const r = assignPods([cube(1, 2, 4)], players(3, () => [1]));
  assert.strictEqual(r.stats.groupSatisfaction, 1);
});

test('stays fast with many cubes and players', () => {
  const cubes = Array.from({ length: 12 }, (_, i) => cube(i + 1, 4, 8));
  const ps = players(40, (i) => cubes.map((c) => Number(c.id)).sort((a, b) => ((a * 7 + i * 13) % 17) - ((b * 7 + i * 13) % 17)));
  const t = Date.now();
  const r = assignPods(cubes, ps);
  checkInvariants(r, cubes, 40);
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t}ms`);
});
