/* The rule that closes the help window's guest features where request limits are not counted (lib/guest-help.ts).
   Pure: no server, no database, no network. Run: node --test apps/website/tests/guest-help.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import {GUEST_LOOKUP_CLOSED, GUEST_MESSAGE_CLOSED, guestHelpOpen} from '../lib/guest-help.ts';

test('production deployment without a rate limiter: guest order lookup and guest messages are closed', () => {
  assert.equal(guestHelpOpen({deployed: true, limiterConfigured: false, required: false}), false);
  assert.equal(guestHelpOpen({deployed: true, limiterConfigured: false, required: true}), false);
});

test('production deployment with a rate limiter configured: open', () => {
  assert.equal(guestHelpOpen({deployed: true, limiterConfigured: true, required: false}), true);
  assert.equal(guestHelpOpen({deployed: true, limiterConfigured: true, required: true}), true);
});

test('outside a deployment: open as before, unless the production rule is asked for there too', () => {
  assert.equal(guestHelpOpen({deployed: false, limiterConfigured: false, required: false}), true, 'local development and the ordinary test servers');
  assert.equal(guestHelpOpen({deployed: false, limiterConfigured: false, required: true}), false, 'the rule applied on purpose, no limiter');
  assert.equal(guestHelpOpen({deployed: false, limiterConfigured: true, required: true}), true, 'the rule applied on purpose, limiter configured');
});

test('every combination: closed exactly when a limiter is required and none is configured', () => {
  for (const deployed of [true, false]) for (const limiterConfigured of [true, false]) for (const required of [true, false])
    assert.equal(guestHelpOpen({deployed, limiterConfigured, required}), limiterConfigured || !(deployed || required), JSON.stringify({deployed, limiterConfigured, required}));
});

test('what a closed feature says: plain words, a way on, and no claim that limits are active', () => {
  for (const m of [GUEST_LOOKUP_CLOSED, GUEST_MESSAGE_CLOSED]) {
    assert.match(m, /sign in/i);
    assert.doesNotMatch(m, /rate|limit|redis|error|protected|secure/i);
  }
});
