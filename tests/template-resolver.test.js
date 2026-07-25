/**
 * Tests for TemplateResolver and 2D classification routing
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TemplateResolver = require('../src/template-resolver');
const { DEFAULT_MAX_ITERATIONS } = require('../src/agent/agent-config');

// Copy of getConfig logic from config-router.js for testing
function getConfig(complexity, taskType) {
  const getBase = () => {
    if (taskType === 'DEBUG' && complexity !== 'TRIVIAL') {
      return 'debug-workflow';
    }
    if (complexity === 'TRIVIAL') {
      return 'single-worker';
    }
    if (complexity === 'SIMPLE') {
      return 'worker-validator';
    }
    return 'full-workflow';
  };

  const getLevel = (role) => {
    if (complexity === 'CRITICAL' && role === 'planner') return 'level3';
    if (complexity === 'TRIVIAL') return 'level1';
    return 'level2';
  };

  const getValidatorCount = () => {
    if (complexity === 'TRIVIAL') return 0;
    if (complexity === 'SIMPLE') return 1;
    if (complexity === 'STANDARD') return 2;
    if (complexity === 'CRITICAL') return 0; // Two-stage validation with dynamic loading
    return 1;
  };

  const getMaxTokens = () => {
    if (complexity === 'TRIVIAL') return 50000;
    if (complexity === 'SIMPLE') return 100000;
    if (complexity === 'STANDARD') return 100000;
    if (complexity === 'CRITICAL') return 150000;
    return 100000;
  };

  const base = getBase();

  const params = {
    task_type: taskType,
    complexity,
    max_tokens: getMaxTokens(),
    max_iterations: DEFAULT_MAX_ITERATIONS,
  };

  if (base === 'single-worker') {
    params.worker_level = getLevel('worker');
  } else if (base === 'worker-validator') {
    params.worker_level = getLevel('worker');
    params.validator_level = getLevel('validator');
  } else if (base === 'debug-workflow') {
    params.investigator_level = getLevel('planner');
    params.fixer_level = getLevel('worker');
    params.tester_level = getLevel('validator');
  } else if (base === 'full-workflow') {
    params.planner_level = getLevel('planner');
    params.worker_level = getLevel('worker');
    params.validator_level = getLevel('validator');
    params.validator_count = getValidatorCount();
  }

  return { base, params };
}

const COMPLEXITIES = ['TRIVIAL', 'SIMPLE', 'STANDARD', 'CRITICAL'];
const TASK_TYPES = ['INQUIRY', 'TASK', 'DEBUG'];

describe('TemplateResolver', function () {
  let resolver;

  before(function () {
    const templatesDir = path.join(__dirname, '..', 'cluster-templates');
    resolver = new TemplateResolver(templatesDir);
  });

  describe('listTemplates', function () {
    it('should list all base templates', function () {
      const templates = resolver.listTemplates();
      assert.ok(templates.includes('single-worker'));
      assert.ok(templates.includes('worker-validator'));
      assert.ok(templates.includes('debug-workflow'));
      assert.ok(templates.includes('full-workflow'));
    });
  });

  describe('getTemplateInfo', function () {
    it('should return template metadata', function () {
      const info = resolver.getTemplateInfo('single-worker');
      assert.ok(info.name);
      assert.ok(info.description);
      assert.ok(info.params);
      assert.ok(info.params.worker_level);
    });

    it('should return null for non-existent template', function () {
      const info = resolver.getTemplateInfo('does-not-exist');
      assert.strictEqual(info, null);
    });
  });

  describe('resolve', function () {
    it('should resolve single-worker template', function () {
      const resolved = resolver.resolve('single-worker', {
        task_type: 'TASK',
        complexity: 'TRIVIAL',
        max_tokens: 50000,
        max_iterations: DEFAULT_MAX_ITERATIONS,
        worker_level: 'level1',
      });

      assert.ok(resolved.agents);
      assert.strictEqual(resolved.agents.length, 1);

      const worker = resolved.agents.find((a) => a.id === 'worker');
      assert.strictEqual(worker.modelLevel, 'level1');
    });

    it('should resolve full-workflow with conditional validators', function () {
      const resolved = resolver.resolve('full-workflow', {
        task_type: 'TASK',
        complexity: 'CRITICAL',
        max_tokens: 150000,
        max_iterations: DEFAULT_MAX_ITERATIONS,
        planner_level: 'level3',
        worker_level: 'level2',
        validator_level: 'level2',
        validator_count: 0, // CRITICAL uses two-stage validation (validators loaded dynamically)
      });

      assert.ok(resolved.agents);

      const planner = resolved.agents.find((a) => a.id === 'planner');
      assert.strictEqual(planner.modelLevel, 'level3');

      // CRITICAL tasks use two-stage validation: meta-coordinator loads validators dynamically
      // So inline validators should be filtered out, meta-coordinator should be present
      const validators = resolved.agents.filter((a) => a.role === 'validator');
      assert.strictEqual(validators.length, 0);

      const metaCoordinator = resolved.agents.find((a) => a.id === 'meta-coordinator');
      assert.ok(metaCoordinator, 'meta-coordinator should be present for CRITICAL tasks');
    });

    it('should fail on missing required params', function () {
      assert.throws(() => resolver.resolve('single-worker', {}), /Missing required params/);
    });

    it('should fail on non-existent template', function () {
      assert.throws(() => resolver.resolve('does-not-exist', {}), /Base template not found/);
    });
  });
});

describe('TemplateResolver config references', function () {
  let tempDir;
  let templatesDir;
  let resolver;

  beforeEach(function () {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-template-reference-'));
    templatesDir = path.join(tempDir, 'cluster-templates');
    fs.mkdirSync(path.join(templatesDir, 'base-templates'), { recursive: true });

    fs.writeFileSync(
      path.join(templatesDir, 'safe-config_1.json'),
      JSON.stringify({ agents: [{ id: 'static-agent' }] })
    );
    fs.writeFileSync(
      path.join(templatesDir, 'no-agents.json'),
      JSON.stringify({ name: 'no agents' })
    );
    fs.writeFileSync(
      path.join(templatesDir, 'base-templates', 'safe-base_template.json'),
      JSON.stringify({ agents: [{ id: 'parameterized-agent' }] })
    );

    // These files prove traversal would reach valid JSON rather than merely
    // failing because the escaped target happens not to exist.
    fs.writeFileSync(
      path.join(tempDir, 'outside-static.json'),
      JSON.stringify({ agents: [{ id: 'outside-static' }] })
    );
    fs.writeFileSync(
      path.join(templatesDir, 'outside-base.json'),
      JSON.stringify({ agents: [{ id: 'outside-base' }] })
    );

    resolver = new TemplateResolver(templatesDir);
  });

  afterEach(function () {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load static and parameterized names containing hyphens and underscores', function () {
    const staticReference = resolver.resolveConfigReference('safe-config_1');
    assert.strictEqual(staticReference.kind, 'static');
    assert.strictEqual(staticReference.loadedConfig.agents[0].id, 'static-agent');

    const parameterizedReference = resolver.resolveConfigReference({
      base: 'safe-base_template',
      params: {},
    });
    assert.strictEqual(parameterizedReference.kind, 'parameterized');
    assert.strictEqual(parameterizedReference.loadedConfig.agents[0].id, 'parameterized-agent');
  });

  it('should preserve not-found and config-shape behavior for safe names', function () {
    assert.throws(
      () => resolver.resolveConfigReference('does-not-exist'),
      /Config not found: does-not-exist/
    );
    assert.throws(
      () => resolver.resolveConfigReference({ base: 'does-not-exist', params: {} }),
      /Base template not found: does-not-exist/
    );

    const noAgentsReference = resolver.resolveConfigReference('no-agents');
    assert.deepStrictEqual(noAgentsReference.loadedConfig, { name: 'no agents' });
  });

  for (const invalidConfig of [null, {}, { params: {} }, [], 42]) {
    it(`should preserve invalid config format for ${JSON.stringify(invalidConfig)}`, function () {
      assert.throws(
        () => resolver.resolveConfigReference(invalidConfig),
        /Invalid config format: expected string or \{base, params\}/
      );
    });
  }

  for (const unsafeName of [
    '../outside-static',
    String.raw`..\outside-static`,
    path.resolve('/tmp', 'outside-static'),
    'nested/config',
    String.raw`nested\config`,
    String.raw`C:\outside-static`,
    String.raw`\\server\share`,
    '',
    '.',
    '..',
    'name.json',
    'name:config',
    'name config',
  ]) {
    it(`should reject unsafe static config name ${JSON.stringify(unsafeName)}`, function () {
      assert.throws(
        () => resolver.resolveConfigReference(unsafeName),
        /Invalid config name.*letters, numbers, hyphens, and underscores/
      );
    });
  }

  for (const unsafeName of [
    '../outside-base',
    String.raw`..\outside-base`,
    path.resolve('/tmp', 'outside-base'),
    'nested/template',
    String.raw`nested\template`,
    String.raw`C:\outside-base`,
    String.raw`\\server\share`,
    '',
    '.',
    '..',
    'name.json',
    'name:template',
    'name template',
  ]) {
    it(`should reject unsafe parameterized base name ${JSON.stringify(unsafeName)}`, function () {
      assert.throws(
        () => resolver.resolveConfigReference({ base: unsafeName, params: {} }),
        /Invalid base template name.*letters, numbers, hyphens, and underscores/
      );
    });
  }

  it('should reject unsafe names through direct base-template APIs', function () {
    assert.throws(() => resolver.resolve('../outside-base', {}), /Invalid base template name/);
    assert.throws(
      () => resolver.getTemplateInfo(String.raw`..\outside-base`),
      /Invalid base template name/
    );
  });
});

describe('2D Classification Routing', function () {
  let resolver;

  before(function () {
    const templatesDir = path.join(__dirname, '..', 'cluster-templates');
    resolver = new TemplateResolver(templatesDir);
  });

  describe('All 12 combinations', function () {
    for (const complexity of COMPLEXITIES) {
      for (const taskType of TASK_TYPES) {
        const key = `${complexity}:${taskType}`;

        it(`should resolve ${key}`, function () {
          const { base, params } = getConfig(complexity, taskType);
          const resolved = resolver.resolve(base, params);

          assert.ok(resolved.agents, `${key}: No agents`);
          assert.ok(resolved.agents.length > 0, `${key}: Empty agents array`);
        });
      }
    }
  });

  describe('Classification correctness', function () {
    it('TRIVIAL should use single-worker with level1', function () {
      const { base, params } = getConfig('TRIVIAL', 'TASK');
      assert.strictEqual(base, 'single-worker');
      assert.strictEqual(params.worker_level, 'level1');
    });

    it('SIMPLE DEBUG should use debug-workflow', function () {
      const { base, params } = getConfig('SIMPLE', 'DEBUG');
      assert.strictEqual(base, 'debug-workflow');
      assert.strictEqual(params.investigator_level, 'level2');
    });

    it('SIMPLE TASK should use worker-validator', function () {
      const { base } = getConfig('SIMPLE', 'TASK');
      assert.strictEqual(base, 'worker-validator');
    });

    it('STANDARD should use full-workflow with 2 validators', function () {
      const { base, params } = getConfig('STANDARD', 'TASK');
      assert.strictEqual(base, 'full-workflow');
      assert.strictEqual(params.validator_count, 2);
      assert.strictEqual(params.planner_level, 'level2');
    });

    it('CRITICAL should use level3 planner and two-stage validation', function () {
      const { base, params } = getConfig('CRITICAL', 'TASK');
      assert.strictEqual(base, 'full-workflow');
      assert.strictEqual(params.planner_level, 'level3');
      assert.strictEqual(params.validator_count, 0); // Two-stage validation with dynamic loading
      assert.strictEqual(params.max_iterations, DEFAULT_MAX_ITERATIONS);
    });

    it('TRIVIAL DEBUG should still use single-worker (not debug-workflow)', function () {
      const { base } = getConfig('TRIVIAL', 'DEBUG');
      assert.strictEqual(base, 'single-worker');
    });
  });

  describe('Feedback loops preserved', function () {
    it('worker-validator should have rejection trigger', function () {
      const { base, params } = getConfig('SIMPLE', 'TASK');
      const resolved = resolver.resolve(base, params);

      const worker = resolved.agents.find((a) => a.id === 'worker');
      const rejectionTrigger = worker.triggers.find(
        (t) => t.topic === 'VALIDATION_RESULT' && t.logic
      );

      assert.ok(rejectionTrigger, 'Worker should have rejection trigger');
      assert.ok(
        rejectionTrigger.logic.script.includes('approved === false'),
        'Trigger should check for rejection'
      );
    });

    it('debug-workflow should have rejection trigger on fixer', function () {
      const { base, params } = getConfig('SIMPLE', 'DEBUG');
      const resolved = resolver.resolve(base, params);

      const fixer = resolved.agents.find((a) => a.id === 'fixer');
      const rejectionTrigger = fixer.triggers.find(
        (t) => t.topic === 'VALIDATION_RESULT' && t.logic
      );

      assert.ok(rejectionTrigger, 'Fixer should have rejection trigger');
    });

    it('full-workflow should have consensus-based rejection trigger', function () {
      const { base, params } = getConfig('CRITICAL', 'TASK');
      const resolved = resolver.resolve(base, params);

      const worker = resolved.agents.find((a) => a.id === 'worker');
      const rejectionTrigger = worker.triggers.find(
        (t) => t.topic === 'VALIDATION_RESULT' && t.logic
      );

      assert.ok(rejectionTrigger, 'Worker should have rejection trigger');
      assert.ok(
        rejectionTrigger.logic.script.includes('getAgentsByRole'),
        'Should check all validators'
      );
    });
  });
});
