'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  RUN_INTENT_VERSION,
  buildRunIntentEnvelope,
  followRunIntent,
  validateRunIntent,
} = require('../../private/hosted-cli-candidate/run-intent');
const { GRAPH, runIntent, RUN_INTENT_NOW: NOW } = require('./candidate-fixtures');

const CAPSULE_ID = '019fd17e-b9c4-7ef1-99da-cc0ef3905402';

describe('private RunIntent v2 envelope', () => {
  it('contains exactly the validated graph and authority-free job input', () => {
    const input = {
      source: 'prompt',
      prompt: 'Ship the requested change.',
      artifacts: [],
    };
    const envelope = buildRunIntentEnvelope(GRAPH, input);
    assert.deepEqual(envelope, {
      version: RUN_INTENT_VERSION,
      graph: GRAPH,
      input,
    });
    assert.equal(RUN_INTENT_VERSION, 'zeroshot.run-intent/v2');
    assert.deepEqual(Object.keys(envelope), ['version', 'graph', 'input']);
    assert.equal(
      /credentials|token|apiKey|environment|endpoint|settings|command|path|runtime/i.test(
        JSON.stringify(envelope)
      ),
      false
    );
    for (const authority of [
      'isolationProfile',
      'modelLevel',
      'provider',
      'providerProfile',
      'repository',
      'revision',
    ]) {
      assert.throws(
        () => buildRunIntentEnvelope(GRAPH, { ...input, [authority]: 'caller-owned' }),
        /forbidden field/
      );
    }
  });
});

describe('RunIntent lifecycle projection', () => {
  it('rejects every malformed field and unknown state or shape', () => {
    const failed = runIntent({
      state: 'failed',
      error_code: 'runtime_failed',
      terminal_at: NOW,
    });
    const malformed = [
      null,
      [],
      { ...runIntent(), unknown: true },
      { ...runIntent(), intent_id: 'not-a-uuid' },
      { ...runIntent(), state: 'done' },
      { ...runIntent(), waiting_reason: 'later' },
      { ...runIntent(), capsule_id: 'cap-1' },
      { ...runIntent(), result: [] },
      { ...runIntent(), error_code: 42 },
      { ...failed, error_code: '1runtime_failed' },
      { ...failed, error_code: 'Runtime_failed' },
      { ...failed, error_code: `a${'0'.repeat(64)}` },
      { ...runIntent(), submitted_at: 'yesterday' },
      { ...runIntent(), terminal_at: 7 },
    ];
    for (const value of malformed) {
      assert.throws(() => validateRunIntent(value), /invalid RunIntent/);
    }
    assert.deepEqual(validateRunIntent(runIntent()), runIntent());
  });
});

describe('RunIntent observation', () => {
  it('polls validated states to a terminal result without invoking cancellation', async () => {
    const calls = [];
    const states = [
      runIntent({ state: 'running', capsule_id: CAPSULE_ID }),
      runIntent({
        state: 'succeeded',
        capsule_id: CAPSULE_ID,
        result: { summary: 'done' },
        terminal_at: NOW,
      }),
    ];
    const terminal = await followRunIntent(
      {
        get(id) {
          calls.push(['get', id]);
          return states.shift();
        },
        cancel() {
          calls.push(['cancel']);
        },
      },
      runIntent(),
      {
        sleep: () => Promise.resolve(),
        onChange: (intent) => calls.push(['state', intent.state]),
      }
    );
    assert.equal(terminal.state, 'succeeded');
    assert.equal(
      calls.some(([name]) => name === 'cancel'),
      false
    );
    assert.deepEqual(
      calls.filter(([name]) => name === 'state'),
      [
        ['state', 'queued'],
        ['state', 'running'],
        ['state', 'succeeded'],
      ]
    );
  });
});
