/* Rate limiter for public endpoints (2026-10-09), against a local stand-in for the Redis REST API. No database is used
   and nothing leaves this machine. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRateLimiter, retryAfterText} from '@kitsyuu/core';
import {startFakeRedisRest} from './fake-redis-rest.mjs';

const TOKEN = 'test-token-' + 'x'.repeat(24);
let redis;
test.before(async () => { redis = await startFakeRedisRest({token: TOKEN}); });
test.after(async () => { await redis.close(); });
const RULE = {limit: 3, windowSeconds: 60};
const make = (extra = {}) => { const lines = []; return {lines, rl: createRateLimiter({url: redis.url, token: TOKEN, log: l => lines.push(l), ...extra})}; };

test('not configured: no limits, nothing is contacted', async () => {
  redis.reset(); const before = redis.state.requests;
  for (const cfg of [{}, {url: redis.url}, {token: TOKEN}, {url: '  ', token: TOKEN}]) {
    const rl = createRateLimiter(cfg);
    assert.equal(rl.enabled, false);
    for (let i = 0; i < 10; i++) assert.deepEqual(await rl.check('signup', '203.0.113.9', RULE), {allowed: true, limit: 3, count: null, retryAfterSeconds: 0, state: 'off'});
  }
  assert.equal(redis.state.requests, before);
});

test('counts per caller and per limit; the request over the limit is refused with a wait; a new window starts clean', async () => {
  redis.reset();
  let t = 1_000_000_000_000;
  const {rl, lines} = make({now: () => t});
  assert.equal(rl.enabled, true);
  for (let i = 1; i <= 3; i++) assert.deepEqual(await rl.check('newsletter', '203.0.113.9', RULE), {allowed: true, limit: 3, count: i, retryAfterSeconds: 0, state: 'counted'});
  const refused = await rl.check('newsletter', '203.0.113.9', RULE);
  assert.equal(refused.allowed, false); assert.equal(refused.count, 4);
  assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60, String(refused.retryAfterSeconds));
  assert.equal((await rl.check('newsletter', '203.0.113.10', RULE)).allowed, true, 'another caller has its own count');
  assert.equal((await rl.check('signup', '203.0.113.9', RULE)).allowed, true, 'another limit has its own count');
  t += 61_000;
  assert.deepEqual(await rl.check('newsletter', '203.0.113.9', RULE), {allowed: true, limit: 3, count: 1, retryAfterSeconds: 0, state: 'counted'});
  assert.equal(lines.filter(l => /\[rate-limit\] blocked name=newsletter/.test(l)).length, 1, 'the refusal is logged once');
});

test('nothing that identifies a person reaches Redis or the log; every key expires', async () => {
  redis.reset();
  const {rl, lines} = make();
  const email = 'someone.private@example.com', ip = '198.51.100.77';
  for (let i = 0; i < 5; i++) { await rl.check('password-reset', email, RULE); await rl.check('login', ip, RULE); }
  const sent = redis.bodies.join('\n') + [...redis.keys.keys()].join('\n') + lines.join('\n');
  assert.ok(!sent.includes(email) && !sent.includes('someone.private') && !sent.includes(ip), 'identity is hashed');
  assert.ok(lines.length >= 2);
  for (const k of redis.keys.keys()) { assert.match(k, /^kitsyuu:rl:[a-z-]+:[a-f0-9]{32}:\d+$/); assert.equal(redis.expiries.get(k), 65); }
});

test('a caller that cannot be identified is not counted', async () => {
  redis.reset(); const before = redis.state.requests;
  const {rl} = make();
  for (const id of [null, undefined, '']) assert.equal((await rl.check('signup', id, RULE)).state, 'off');
  assert.equal(redis.state.requests, before);
});

test('limiter down, wrong token, nonsense answer or no answer: requests are allowed and the failure is logged, never thrown', async () => {
  redis.reset();
  const {rl, lines} = make();
  redis.state.down = true;
  for (let i = 0; i < 10; i++) assert.deepEqual(await rl.check('signup', '203.0.113.9', RULE), {allowed: true, limit: 3, count: null, retryAfterSeconds: 0, state: 'error'});
  redis.state.down = false;
  assert.equal(lines.filter(l => /ERROR: the limiter is not answering/.test(l)).length, 1, 'logged once a minute, not per request');
  assert.match(lines[0], /Requests are allowed meanwhile/);
  redis.state.garbage = true;
  assert.equal((await make().rl.check('signup', '203.0.113.9', RULE)).state, 'error');
  redis.state.garbage = false;
  const wrong = createRateLimiter({url: redis.url, token: 'not-the-token', log: () => {}});
  assert.deepEqual(await wrong.check('signup', '203.0.113.9', RULE), {allowed: true, limit: 3, count: null, retryAfterSeconds: 0, state: 'error'});
  const dead = createRateLimiter({url: 'http://127.0.0.1:1', token: TOKEN, timeoutMs: 500, log: () => {}});
  assert.equal((await dead.check('signup', '203.0.113.9', RULE)).allowed, true);
  assert.equal(Object.values(Object.fromEntries(redis.keys)).length, 0, 'nothing was counted while it was failing');
  assert.ok(!lines.join('\n').includes(TOKEN), 'the token is never logged');
});

test('onError: deny refuses while the limiter is down, and recovers with it', async () => {
  redis.reset();
  const {rl, lines} = make({onError: 'deny'});
  redis.state.down = true;
  const r = await rl.check('signup', '203.0.113.9', RULE);
  assert.equal(r.allowed, false); assert.equal(r.state, 'error'); assert.ok(r.retryAfterSeconds > 0);
  assert.match(lines[0], /Requests are REFUSED meanwhile/);
  redis.state.down = false;
  assert.equal((await rl.check('signup', '203.0.113.9', RULE)).allowed, true);
});

test('many requests at once never let more than the limit through', async () => {
  redis.reset();
  const {rl} = make();
  const results = await Promise.all(Array.from({length: 40}, () => rl.check('cart-check', '203.0.113.50', {limit: 10, windowSeconds: 3600})));
  assert.equal(results.filter(r => r.allowed).length, 10);
});

test('the wait is worded for a person', () => {
  assert.equal(retryAfterText(1), 'in a moment');
  assert.equal(retryAfterText(40), 'in 40 seconds');
  assert.equal(retryAfterText(600), 'in 10 minutes');
  assert.equal(retryAfterText(601), 'in 11 minutes');
});
