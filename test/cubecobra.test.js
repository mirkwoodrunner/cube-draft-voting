'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseCubeUrl, extractFromJson, extractFromHtml, fetchCubeInfo } = require('../src/cubecobra');

test('parseCubeUrl accepts Cube Cobra links and bare ids', () => {
  for (const input of [
    'https://cubecobra.com/cube/overview/modovintage',
    'https://www.cubecobra.com/cube/list/modovintage?view=table',
    'cubecobra.com/c/modovintage',
    'modovintage'
  ]) assert.strictEqual(parseCubeUrl(input).id, 'modovintage', input);
});

test('parseCubeUrl rejects other hosts, lookalikes and junk', () => {
  for (const input of ['https://evil.com/cube/overview/x', 'https://cubecobra.com.evil.com/cube/overview/x',
    'http://169.254.169.254/', 'https://cubecobra.com/', '', 'not a url']) {
    assert.throws(() => parseCubeUrl(input), undefined, input);
  }
});

test('extractFromJson reads owner objects, strings, card arrays and tags', () => {
  assert.deepStrictEqual(
    extractFromJson({ name: 'Vintage', owner: { username: 'bob' }, cardCount: 540, tags: ['Powered', 'Vintage'] }),
    { name: 'Vintage', author: 'bob', cardCount: 540, tags: ['Powered', 'Vintage'] });
  assert.deepStrictEqual(
    extractFromJson({ name: 'Mini', owner: 'amy', cards: { mainboard: [{}, {}, {}] }, tags: 'a, b' }),
    { name: 'Mini', author: 'amy', cardCount: 3, tags: ['a', 'b'] });
  assert.strictEqual(extractFromJson({ cube: { name: 'Nested', owner: { name: 'z' }, cardCount: 360 } }).author, 'z');
  assert.strictEqual(extractFromJson({ unrelated: true }), null);
});

test('extractFromHtml reads window.reactProps, including braces inside strings', () => {
  const html = `<html><script>window.reactProps = {"cube":{"name":"Odd {name}","owner":{"username":"al"},"cardCount":360,"tags":["x"]},"s":"}\\"{"};</script></html>`;
  assert.deepStrictEqual(extractFromHtml(html), { name: 'Odd {name}', author: 'al', cardCount: 360, tags: ['x'] });
});

test('extractFromHtml falls back to the page title for the name only', () => {
  const r = extractFromHtml('<title>Cube Overview: Peasant &amp; Co - Cube Cobra</title>');
  assert.strictEqual(r.name, 'Peasant & Co');
  assert.strictEqual(r.author, null);
});

test('fetchCubeInfo merges sources and reports not-found', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('/api/cubejson/')) return new Response(JSON.stringify({ name: 'Cube A', cardCount: 360 }), { status: 200 });
    return new Response('<script>window.reactProps = {"cube":{"name":"Cube A","owner":{"username":"sam"},"tags":["t"]}}</script>', { status: 200 });
  };
  const info = await fetchCubeInfo('https://cubecobra.com/cube/overview/abc', { fetchImpl: fakeFetch, baseUrl: 'http://x' });
  assert.deepStrictEqual(info, { cubecobraId: 'abc', url: 'https://cubecobra.com/cube/overview/abc', name: 'Cube A', author: 'sam', cardCount: 360, tags: ['t'] });

  const missing = async () => new Response('nope', { status: 404 });
  await assert.rejects(fetchCubeInfo('abc', { fetchImpl: missing, baseUrl: 'http://x' }), /not found/i);
  const down = async () => { throw new Error('boom'); };
  await assert.rejects(fetchCubeInfo('abc', { fetchImpl: down, baseUrl: 'http://x' }), /Could not reach/);
});
