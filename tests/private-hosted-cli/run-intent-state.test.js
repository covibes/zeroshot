'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { validateRunIntent } = require('../../private/hosted-cli-candidate/run-intent');
const { runIntent, RUN_INTENT_NOW: NOW } = require('./candidate-fixtures');

const CAPSULE_ID = '019fd17e-b9c4-7ef1-99da-cc0ef3905402';

describe('RunIntent state invariants', () => {
  it('enforces the response invariants for every lifecycle state', () => {
    const waiting = 'plan_concurrency_limit_reached';
    const active = { capsule_id: CAPSULE_ID };
    const terminal = { terminal_at: NOW };
    const valid = [
      runIntent({ waiting_reason: waiting }),
      runIntent({ state: 'provisioning', ...active }),
      runIntent({ state: 'running', ...active }),
      runIntent({ state: 'cancelling', ...active }),
      runIntent({ state: 'succeeded', ...active, ...terminal }),
      runIntent({ state: 'succeeded', ...active, ...terminal, result: { summary: 'done' } }),
      runIntent({ state: 'failed', ...terminal, error_code: 'runtime_failed' }),
      runIntent({ state: 'failed', ...active, ...terminal, error_code: 'runtime_failed' }),
      runIntent({ state: 'failed', ...terminal, error_code: `a${'0'.repeat(63)}` }),
      runIntent({ state: 'cancelled', ...terminal }),
      runIntent({ state: 'expired', ...active, ...terminal }),
    ];
    for (const value of valid) {
      assert.equal(validateRunIntent(value), value);
    }

    const contradictory = [
      runIntent({ result: {} }),
      runIntent({ error_code: 'queue_failed' }),
      runIntent({ terminal_at: NOW }),
      runIntent({ state: 'provisioning' }),
      runIntent({ state: 'running', ...active, waiting_reason: waiting }),
      runIntent({ state: 'cancelling', ...active, result: {} }),
      runIntent({ state: 'running', ...active, error_code: 'runtime_failed' }),
      runIntent({ state: 'running', ...active, terminal_at: NOW }),
      runIntent({ state: 'succeeded', ...terminal }),
      runIntent({ state: 'succeeded', ...active, ...terminal, waiting_reason: waiting }),
      runIntent({ state: 'succeeded', ...active, ...terminal, error_code: 'runtime_failed' }),
      runIntent({ state: 'succeeded', ...active }),
      runIntent({ state: 'failed', ...terminal, waiting_reason: waiting, error_code: 'failed' }),
      runIntent({ state: 'failed', ...terminal, result: {}, error_code: 'failed' }),
      runIntent({ state: 'failed', ...terminal }),
      runIntent({ state: 'failed', error_code: 'failed' }),
      runIntent({ state: 'cancelled', ...terminal, waiting_reason: waiting }),
      runIntent({ state: 'cancelled', ...terminal, result: {} }),
      runIntent({ state: 'expired', ...terminal, error_code: 'expired' }),
      runIntent({ state: 'expired' }),
    ];
    for (const value of contradictory) {
      assert.throws(() => validateRunIntent(value), /invalid RunIntent/);
    }
  });
});
