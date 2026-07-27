const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const AgentWrapper = require('../src/agent-wrapper');

// Mock message bus and cluster
const mockMessageBus = { publish: () => {}, subscribe: () => {} };
const mockCluster = { id: 'test-cluster', agents: [] };

// Test settings directory (isolated)
const TEST_STORAGE_DIR = path.join(os.tmpdir(), 'zeroshot-model-selection-test-' + Date.now());
const TEST_SETTINGS_FILE = path.join(TEST_STORAGE_DIR, 'settings.json');

function createAgent(agentConfig) {
  return new AgentWrapper(agentConfig, mockMessageBus, mockCluster, {
    testMode: true,
    mockSpawnFn: () => {},
  });
}

function registerModelSelectionHooks() {
  before(function () {
    if (!fs.existsSync(TEST_STORAGE_DIR)) {
      fs.mkdirSync(TEST_STORAGE_DIR, { recursive: true });
    }
    const testSettings = {
      maxModel: 'opus',
      defaultProvider: 'claude',
      defaultConfig: 'conductor-bootstrap',
      defaultDocker: false,
      strictSchema: true,
      logLevel: 'normal',
    };
    fs.writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(testSettings, null, 2), 'utf8');
    process.env.ZEROSHOT_SETTINGS_FILE = TEST_SETTINGS_FILE;
  });

  after(function () {
    delete process.env.ZEROSHOT_SETTINGS_FILE;

    try {
      fs.rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
    } catch (e) {
      console.error('Cleanup failed:', e.message);
    }
  });
}

function registerStaticModelTests() {
  describe('Static model (backward compatibility)', () => {
    it('should use static model when no rules provided', () => {
      const agent = createAgent({ id: 'test', model: 'opus', timeout: 0 });

      assert.strictEqual(agent._selectModel(), 'opus');
    });

    it('should default to provider level2 if no model specified', () => {
      const agent = createAgent({ id: 'test', timeout: 0 });

      // When no model specified, defaults to provider level2 (sonnet for claude)
      assert.strictEqual(agent._selectModel(), 'sonnet');
    });
  });
}

function registerModelSpecSourceTests() {
  describe('Task runner model provenance', () => {
    function captureTaskRunnerOptions(agentConfig, iteration = 0) {
      let capturedOptions;
      const agent = new AgentWrapper(agentConfig, mockMessageBus, mockCluster, {
        testMode: true,
        taskRunner: {
          run(_context, options) {
            capturedOptions = options;
            return { success: true };
          },
        },
      });

      agent.iteration = iteration;
      agent.mockSpawnFn([], { context: 'test context' });
      return capturedOptions;
    }

    it('marks static direct models separately from provider-level selections', () => {
      assert.strictEqual(
        captureTaskRunnerOptions({ id: 'direct', model: 'opus', timeout: 0 }).modelSpecSource,
        'direct'
      );
      assert.strictEqual(
        captureTaskRunnerOptions({ id: 'level', modelLevel: 'level2', timeout: 0 }).modelSpecSource,
        'provider-level'
      );
    });

    it('tracks the matching rule source for each iteration', () => {
      const agentConfig = {
        id: 'rules',
        timeout: 0,
        modelRules: [
          { iterations: '1', model: 'haiku' },
          { iterations: '2+', modelLevel: 'level2' },
        ],
      };

      assert.strictEqual(captureTaskRunnerOptions(agentConfig, 1).modelSpecSource, 'direct');
      assert.strictEqual(
        captureTaskRunnerOptions(agentConfig, 2).modelSpecSource,
        'provider-level'
      );
    });
  });
}

function registerDynamicModelRulesTests() {
  describe('Dynamic model rules', () => {
    it('should match exact iteration', () => {
      const agent = createAgent({
        id: 'test',
        timeout: 0,
        modelRules: [
          { iterations: '1', model: 'haiku' },
          { iterations: '2', model: 'sonnet' },
          { iterations: '3+', model: 'opus' },
        ],
      });

      agent.iteration = 1;
      assert.strictEqual(agent._selectModel(), 'haiku');

      agent.iteration = 2;
      assert.strictEqual(agent._selectModel(), 'sonnet');
    });

    it('should match range', () => {
      const agent = createAgent({
        id: 'test',
        timeout: 0,
        modelRules: [
          { iterations: '1-3', model: 'sonnet' },
          { iterations: 'all', model: 'opus' },
        ],
      });

      agent.iteration = 1;
      assert.strictEqual(agent._selectModel(), 'sonnet');

      agent.iteration = 3;
      assert.strictEqual(agent._selectModel(), 'sonnet');

      agent.iteration = 4;
      assert.strictEqual(agent._selectModel(), 'opus');
    });

    it('should match open-ended range', () => {
      const agent = createAgent({
        id: 'test',
        timeout: 0,
        modelRules: [
          { iterations: '1', model: 'sonnet' },
          { iterations: '2+', model: 'opus' },
        ],
      });

      agent.iteration = 1;
      assert.strictEqual(agent._selectModel(), 'sonnet');

      agent.iteration = 2;
      assert.strictEqual(agent._selectModel(), 'opus');

      agent.iteration = 5;
      assert.strictEqual(agent._selectModel(), 'opus');

      agent.iteration = 100;
      assert.strictEqual(agent._selectModel(), 'opus');
    });

    it('should use catch-all as fallback', () => {
      const agent = createAgent({
        id: 'test',
        timeout: 0,
        modelRules: [
          { iterations: '1', model: 'haiku' },
          { iterations: 'all', model: 'sonnet' },
        ],
      });

      agent.iteration = 999;
      assert.strictEqual(agent._selectModel(), 'sonnet');
    });

    it('should use first matching rule', () => {
      const agent = createAgent({
        id: 'test',
        timeout: 0,
        modelRules: [
          { iterations: '1-10', model: 'sonnet' },
          { iterations: '5+', model: 'opus' }, // Overlaps but shouldn't match
        ],
      });

      agent.iteration = 7;
      assert.strictEqual(agent._selectModel(), 'sonnet'); // First rule wins
    });
  });
}

function registerErrorHandlingTests() {
  describe('Error handling', () => {
    it('should throw if no rules match', () => {
      const agent = createAgent({
        id: 'test',
        timeout: 0,
        modelRules: [{ iterations: '1-2', model: 'sonnet' }],
      });

      agent.iteration = 5;
      assert.throws(() => agent._selectModel(), /No model rule matched iteration 5/);
    });

    it('should throw on invalid pattern syntax', () => {
      const agent = createAgent({
        id: 'test',
        timeout: 0,
        modelRules: [{ iterations: 'invalid', model: 'sonnet' }],
      });

      agent.iteration = 1;
      assert.throws(() => agent._selectModel(), /Invalid iteration pattern 'invalid'/);
    });
  });
}

function registerRealWorldUseCaseTests() {
  describe('Real-world use case', () => {
    it('should escalate from sonnet to opus on second iteration', () => {
      const agent = createAgent({
        id: 'worker',
        timeout: 0,
        modelRules: [
          { iterations: '1', model: 'sonnet' },
          { iterations: '2+', model: 'opus' },
        ],
      });

      agent.iteration = 1;
      assert.strictEqual(agent._selectModel(), 'sonnet', 'First iteration should use sonnet');

      agent.iteration = 2;
      assert.strictEqual(agent._selectModel(), 'opus', 'Second iteration should escalate to opus');

      agent.iteration = 3;
      assert.strictEqual(agent._selectModel(), 'opus', 'Third iteration should stay on opus');
    });
  });
}

describe('Model Selection', () => {
  registerModelSelectionHooks();
  registerStaticModelTests();
  registerModelSpecSourceTests();
  registerDynamicModelRulesTests();
  registerErrorHandlingTests();
  registerRealWorldUseCaseTests();
});
