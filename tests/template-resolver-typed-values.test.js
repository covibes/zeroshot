const assert = require('assert');
const path = require('path');

const { DEFAULT_MAX_ITERATIONS } = require('../src/agent/agent-config');
const { getConfig } = require('../src/config-router');
const TemplateResolver = require('../src/template-resolver');

describe('TemplateResolver typed placeholders', function () {
  const templatesDir = path.join(__dirname, '..', 'cluster-templates');
  const resolver = new TemplateResolver(templatesDir);

  it('preserves exact JSON types while embedded values remain strings', function () {
    const resolved = resolver.resolveTemplate(
      {
        params: {
          count: {},
          enabled: {},
          settings: {},
        },
        exact: {
          count: '{{count}}',
          enabled: '{{enabled}}',
          settings: '{{settings}}',
        },
        embedded: 'count={{count}}, enabled={{enabled}}',
      },
      {
        count: 7,
        enabled: false,
        settings: { retries: 2, labels: ['fast', 'local'] },
      }
    );

    assert.strictEqual(resolved.exact.count, 7);
    assert.strictEqual(typeof resolved.exact.count, 'number');
    assert.strictEqual(resolved.exact.enabled, false);
    assert.strictEqual(typeof resolved.exact.enabled, 'boolean');
    assert.deepStrictEqual(resolved.exact.settings, {
      retries: 2,
      labels: ['fast', 'local'],
    });
    assert.strictEqual(typeof resolved.exact.settings, 'object');
    assert.strictEqual(resolved.embedded, 'count=7, enabled=false');
    assert.strictEqual(typeof resolved.embedded, 'string');
  });

  for (const [complexity, taskType, agentId] of [
    ['SIMPLE', 'TASK', 'worker'],
    ['STANDARD', 'TASK', 'worker'],
    ['SIMPLE', 'DEBUG', 'fixer'],
  ]) {
    it(`preserves numeric maxIterations for ${complexity} ${taskType}`, function () {
      const { base, params } = getConfig(complexity, taskType);
      const resolved = resolver.resolve(base, params);
      const agent = resolved.agents.find((candidate) => candidate.id === agentId);

      assert.ok(agent, `${agentId} should be present`);
      assert.strictEqual(agent.maxIterations, DEFAULT_MAX_ITERATIONS);
      assert.strictEqual(typeof agent.maxIterations, 'number');
    });
  }
});
