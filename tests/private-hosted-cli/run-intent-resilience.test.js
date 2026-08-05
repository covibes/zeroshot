'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  MAX_TRANSIENT_POLL_FAILURES,
  RunIntentHttpError,
  RunIntentTransportError,
  followRunIntent,
} = require('../../private/hosted-cli-candidate/run-intent');
const { runIntent, RUN_INTENT_NOW: NOW } = require('./candidate-fixtures');

describe('RunIntent observation resilience', () => {
  it('reconnects transient status failures with bounded backoff', async () => {
    const calls = [];
    let attempts = 0;
    const terminal = await followRunIntent(
      {
        get() {
          attempts += 1;
          if (attempts === 1) throw new RunIntentTransportError('offline');
          if (attempts === 2) throw new RunIntentHttpError(503);
          return runIntent({
            state: 'succeeded',
            result: { summary: 'done' },
            terminal_at: NOW,
          });
        },
      },
      runIntent(),
      {
        sleep: (milliseconds) => {
          calls.push(milliseconds);
          return Promise.resolve();
        },
      }
    );
    assert.equal(terminal.state, 'succeeded');
    assert.deepEqual(calls, [500, 1000, 500, 2000, 500]);

    await assert.rejects(
      followRunIntent(
        {
          get() {
            throw new RunIntentHttpError(503);
          },
        },
        runIntent(),
        { sleep: () => Promise.resolve() }
      ),
      (error) => error instanceof RunIntentHttpError && error.status === 503
    );
    assert.equal(MAX_TRANSIENT_POLL_FAILURES, 3);
  });
});
