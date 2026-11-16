'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reportText, splitMessage, cleanNote, sniffImage } = require('../src/decks');
const { safeName } = require('../src/webhook');

const m = (id, round, p1, p2, w1, w2, d = 0) => ({ id, round, p1, p2, w1, w2, d });

test('report lists each match from the player\'s side with the opponent\'s deck', () => {
  const text = reportText({
    name: 'Chris',
    cubeName: 'Pauper Cube',
    deck: { deckName: 'Bant Broodscale' },
    matches: [m('b', 2, 'Esper', 'Chris', 2, 0), m('a', 1, 'Chris', 'Boros', 1, 2), m('c', 3, 'Chris', 'Izzet', 2, 1), m('x', 1, 'Q', 'R', 2, 0)],
    deckNames: { Boros: 'Boros Energy' }
  });
  assert.equal(text, 'Bant Broodscale went 1-2 in Pauper Cube\n\n1-2 vs Boros on Boros Energy\n0-2 vs Esper\n2-1 vs Izzet');
});

test('report with notes spaces matches apart and ends with the overall notes', () => {
  const text = reportText({
    name: 'A',
    deck: { deckName: 'Mardu Lurrus', notes: 'Fun cube!', matchNotes: { a: 'Reanimated Fury.' } },
    matches: [m('a', 1, 'A', 'Zach', 2, 0), m('b', 2, 'Will', 'A', 0, 2), m('c', 3, 'A', 'Matt', 2, 1)]
  });
  assert.equal(text, '3-0 undefeated with Mardu Lurrus! 🏆\n\n2-0 vs Zach\nReanimated Fury.\n\n2-0 vs Will\n\n2-1 vs Matt\n\nFun cube!');
});

test('report skips unplayed pairings and shows draws', () => {
  const text = reportText({ name: 'A', matches: [m('a', 1, 'A', 'B', 1, 1, 1), { id: 'b', round: 2, p1: 'A', p2: 'C', w1: null, w2: null, d: null }] });
  assert.equal(text, 'My deck went 0-0-1\n\n1-1-1 vs B');
});

test('long reports split at blank lines under the limit', () => {
  const parts = splitMessage(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)].join('\n\n'), 70);
  assert.deepEqual(parts, [`${'a'.repeat(30)}\n\n${'b'.repeat(30)}`, 'c'.repeat(30)]);
  assert.ok(splitMessage('x'.repeat(150), 70).every((p) => p.length <= 70));
});

test('notes keep line breaks and drop extra blank lines', () => {
  assert.equal(cleanNote('  G1 won\r\n\r\n\r\n\r\nG2 lost  ', 100), 'G1 won\n\nG2 lost');
  assert.equal(cleanNote('   ', 100), null);
  assert.throws(() => cleanNote('abc', 2));
});

test('photos are recognised by their bytes', () => {
  assert.equal(sniffImage(Buffer.from('ffd8ffe000104a4649460001', 'hex')), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
});

test('webhook names Discord would refuse fall back', () => {
  assert.equal(safeName('Chris'), 'Chris');
  assert.equal(safeName('discordfan'), 'Cube Draft');
});
