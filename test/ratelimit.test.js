'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { rateLimit } = require('../src/ratelimit');

const fakeRes = () => {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const call = (limiter, ip = '1.2.3.4') => {
  const res = fakeRes();
  let passed = false;
  limiter({ ip }, res, () => { passed = true; });
  return { res, passed };
};

test('allows up to the limit per key, then answers 429 with Retry-After', () => {
  const lim = rateLimit({ windowMs: 60000, limit: 2 });
  assert.ok(call(lim).passed);
  assert.ok(call(lim).passed);
  const third = call(lim);
  assert.strictEqual(third.passed, false);
  assert.strictEqual(third.res.statusCode, 429);
  assert.ok(Number(third.res.headers['Retry-After']) > 0);
  assert.ok(call(lim, '5.6.7.8').passed, 'another IP has its own allowance');
});

test('onlyFailures blocks parallel guesses and gives back successful requests', () => {
  const lim = rateLimit({ windowMs: 60000, limit: 3, onlyFailures: true });
  // Three requests in flight at once use up the allowance before any of them finishes.
  const inFlight = [call(lim), call(lim), call(lim)];
  assert.ok(inFlight.every((x) => x.passed));
  assert.strictEqual(call(lim).passed, false);
  // One of them turns out to be a correct password, so its slot comes back.
  inFlight[0].res.statusCode = 200;
  inFlight[0].res.emit('finish');
  assert.ok(call(lim).passed);
});
