const assert = require('assert');
const { EVENT_COPY, formatMergeStatus } = require('../cli/event-copy');
const { partitionValidationCriteria } = require('../cli/message-formatter-utils');
const {
  formatImplementationReady: formatImplementationReadyNormal,
  formatPrCreated: formatPrCreatedNormal,
} = require('../cli/message-formatters-normal');
const {
  formatImplementationReady: formatImplementationReadyWatch,
  formatPrCreated: formatPrCreatedWatch,
} = require('../cli/message-formatters-watch');

describe('formatMergeStatus', () => {
  it('returns "merged" for true (boolean or string)', () => {
    assert.strictEqual(formatMergeStatus(true), 'merged');
    assert.strictEqual(formatMergeStatus('true'), 'merged');
  });

  it('returns "auto-merge pending approval" for false (boolean or string)', () => {
    assert.strictEqual(formatMergeStatus(false), 'auto-merge pending approval');
    assert.strictEqual(formatMergeStatus('false'), 'auto-merge pending approval');
  });

  it('returns null for undefined/unknown values', () => {
    assert.strictEqual(formatMergeStatus(undefined), null);
    assert.strictEqual(formatMergeStatus('unknown'), null);
  });
});

describe('partitionValidationCriteria', () => {
  it('classifies temporary and permanent validation limitations in input order', () => {
    const pending = { id: 'pending', status: 'CANNOT_VALIDATE_YET' };
    const permanent = { id: 'permanent', status: 'CANNOT_VALIDATE' };
    const passed = { id: 'passed', status: 'PASS' };

    assert.deepStrictEqual(partitionValidationCriteria([pending, passed, permanent, pending]), {
      cannotValidateYet: [pending, pending],
      cannotValidate: [permanent],
    });
  });
});

describe('EVENT_COPY wording shared across normal and watch formatters', () => {
  it('normal formatImplementationReady includes uppercased EVENT_COPY text', () => {
    const lines = [];
    formatImplementationReadyNormal({ content: {} }, 'prefix', 'ts', (line) => lines.push(line));
    const joined = lines.join('\n');
    assert.ok(joined.includes(EVENT_COPY.IMPLEMENTATION_READY.toUpperCase()));
  });

  it('watch formatImplementationReady includes lowercased EVENT_COPY text', () => {
    const lines = [];
    const origLog = console.log;
    console.log = (line) => lines.push(line);
    try {
      formatImplementationReadyWatch({ sender: 'worker', content: {} }, 'prefix');
    } finally {
      console.log = origLog;
    }
    const joined = lines.join('\n');
    assert.ok(joined.includes(EVENT_COPY.IMPLEMENTATION_READY.toLowerCase()));
  });

  it('normal formatPrCreated shows "auto-merge pending approval" when merged is false', () => {
    const lines = [];
    formatPrCreatedNormal(
      { content: { data: { pr_number: 1, merged: false } } },
      'prefix',
      'ts',
      (line) => lines.push(line)
    );
    const joined = lines.join('\n');
    assert.ok(joined.includes('auto-merge pending approval'));
  });

  it('normal formatPrCreated shows "merged" when merged is true', () => {
    const lines = [];
    formatPrCreatedNormal(
      { content: { data: { pr_number: 1, merged: true } } },
      'prefix',
      'ts',
      (line) => lines.push(line)
    );
    const joined = lines.join('\n');
    assert.ok(joined.includes('merged'));
  });

  it('watch formatPrCreated shows "auto-merge pending approval" when merged is false', () => {
    const lines = [];
    const origLog = console.log;
    console.log = (line) => lines.push(line);
    try {
      formatPrCreatedWatch(
        { sender: 'git-pusher', content: { data: { pr_number: 1, merged: false } } },
        'prefix'
      );
    } finally {
      console.log = origLog;
    }
    const joined = lines.join('\n');
    assert.ok(joined.includes('auto-merge pending approval'));
  });

  it('watch formatPrCreated shows "merged" when merged is true', () => {
    const lines = [];
    const origLog = console.log;
    console.log = (line) => lines.push(line);
    try {
      formatPrCreatedWatch(
        { sender: 'git-pusher', content: { data: { pr_number: 1, merged: true } } },
        'prefix'
      );
    } finally {
      console.log = origLog;
    }
    const joined = lines.join('\n');
    assert.ok(joined.includes('merged'));
  });
});
