const assert = require('assert');
const {
  DEFAULT_LIVENESS_CHECK_ENABLED,
  validateAgentConfig,
} = require('../src/agent/agent-config');

describe('agent liveness configuration', function () {
  it('does not impose an output-silence timeout by default', function () {
    const config = validateAgentConfig({
      id: 'unbounded-agent',
      role: 'implementation',
      timeout: 0,
      triggers: [],
    });

    assert.strictEqual(DEFAULT_LIVENESS_CHECK_ENABLED, false);
    assert.strictEqual(config.timeout, 0);
    assert.strictEqual(config.enableLivenessCheck, false);
  });

  it('preserves explicit liveness watchdog opt-in', function () {
    const config = validateAgentConfig({
      id: 'watched-agent',
      role: 'implementation',
      timeout: 0,
      staleDuration: 5000,
      enableLivenessCheck: true,
      triggers: [],
    });

    assert.strictEqual(config.enableLivenessCheck, true);
    assert.strictEqual(config.staleDuration, 5000);
  });
});
