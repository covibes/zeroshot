'use strict';

const assert = require('node:assert');
const { evaluateAudit } = require('../../scripts/audit-production-dependencies');

const approvedLock = {
  packages: {
    '': { dependencies: { opcore: '0.2.1' } },
    'node_modules/opcore': { version: '0.2.1' },
    'node_modules/opcore/node_modules/brace-expansion': { version: '5.0.6' },
    'node_modules/opcore/node_modules/smol-toml': { version: '1.6.0' },
  },
};

function advisory(source) {
  return { source, name: 'dependency', severity: 'high' };
}

function vulnerability(name, severity, via, direct = false) {
  const prefix = 'node_modules/opcore/node_modules/';
  return {
    severity,
    isDirect: direct,
    via,
    nodes: [name === 'opcore' ? 'node_modules/opcore' : `${prefix}${name}`],
  };
}

function approvedReport() {
  return {
    vulnerabilities: {
      'brace-expansion': vulnerability('brace-expansion', 'high', [
        advisory(1123898),
        advisory(1130591),
      ]),
      'smol-toml': vulnerability('smol-toml', 'moderate', [advisory(1115393)]),
      '@the-open-engine/opcore-validation-python': vulnerability(
        '@the-open-engine/opcore-validation-python',
        'moderate',
        ['smol-toml']
      ),
      '@the-open-engine/opcore-validation-policy': vulnerability(
        '@the-open-engine/opcore-validation-policy',
        'moderate',
        ['@the-open-engine/opcore-validation-python']
      ),
      '@the-open-engine/opcore-asp-provider': vulnerability(
        '@the-open-engine/opcore-asp-provider',
        'moderate',
        ['@the-open-engine/opcore-validation-policy', '@the-open-engine/opcore-validation-python']
      ),
      opcore: vulnerability('opcore', 'high', ['brace-expansion', 'smol-toml'], true),
    },
  };
}

describe('production dependency audit policy', function () {
  it('allows only the pinned Opcore advisory closure', function () {
    const result = evaluateAudit(approvedReport(), approvedLock);
    assert.deepStrictEqual(result.blocked, []);
    assert.strictEqual(result.allowed.length, 6);
    assert.strictEqual(result.versionMismatch, false);
  });

  it('blocks a new advisory on an otherwise approved leaf', function () {
    const report = approvedReport();
    report.vulnerabilities['brace-expansion'].via.push(advisory(9999999));
    const result = evaluateAudit(report, approvedLock);
    assert.deepStrictEqual(result.blocked.map(([name]) => name).sort(), [
      'brace-expansion',
      'opcore',
    ]);
  });

  it('blocks an unrelated production vulnerability', function () {
    const report = approvedReport();
    report.vulnerabilities.unrelated = {
      severity: 'critical',
      via: [advisory(1234)],
      nodes: ['node_modules/unrelated'],
    };
    const result = evaluateAudit(report, approvedLock);
    assert.deepStrictEqual(
      result.blocked.map(([name]) => name),
      ['unrelated']
    );
  });

  it('blocks the exception when any pinned package version changes', function () {
    const changedLock = JSON.parse(JSON.stringify(approvedLock));
    changedLock.packages['node_modules/opcore'].version = '0.2.2';
    const result = evaluateAudit(approvedReport(), changedLock);
    assert.strictEqual(result.versionMismatch, true);
    assert.strictEqual(result.blocked.length, 6);
  });

  it('passes a clean audit without consulting exception versions', function () {
    assert.deepStrictEqual(evaluateAudit({ vulnerabilities: {} }, {}), {
      allowed: [],
      blocked: [],
      versionMismatch: false,
    });
  });
});
