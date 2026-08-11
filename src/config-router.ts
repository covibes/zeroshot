/**
 * Config Router - Maps 2D classification to parameterized templates
 *
 * Single source of truth for: Complexity × TaskType → { base, params }
 * Used by both logic-engine.js (trigger evaluation) and agent-wrapper.js (transform scripts)
 */

interface AgentConfigModule {
  DEFAULT_MAX_ITERATIONS: number;
}

function isAgentConfigModule(value: unknown): value is AgentConfigModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'DEFAULT_MAX_ITERATIONS' in value &&
    typeof value.DEFAULT_MAX_ITERATIONS === 'number'
  );
}

const agentConfig: unknown = require('./agent/agent-config');
if (!isAgentConfigModule(agentConfig)) {
  throw new TypeError('agent-config must export a numeric DEFAULT_MAX_ITERATIONS');
}
const { DEFAULT_MAX_ITERATIONS } = agentConfig;

type BaseConfigName = 'debug-workflow' | 'full-workflow' | 'single-worker' | 'worker-validator';
type ModelLevel = 'level1' | 'level2' | 'level3';

interface ConfigOptions {
  autoPr?: boolean;
}

interface ConfigParams {
  task_type: string;
  complexity: string;
  max_tokens: number;
  max_iterations: number;
  worker_level?: ModelLevel;
  validator_level?: ModelLevel;
  investigator_level?: ModelLevel;
  fixer_level?: ModelLevel;
  tester_level?: ModelLevel;
  planner_level?: ModelLevel;
  validator_count?: number;
}

interface RoutedConfig {
  base: BaseConfigName;
  params: ConfigParams;
}

/**
 * Get cluster config based on complexity and task type
 */
function getConfig(
  complexity: string,
  taskType: string,
  options: ConfigOptions = {}
): RoutedConfig {
  const isPrMode = options.autoPr === true || process.env.ZEROSHOT_PR === '1';

  const getBase = (): BaseConfigName => {
    if (taskType === 'DEBUG' && complexity !== 'TRIVIAL') {
      return 'debug-workflow';
    }
    if (complexity === 'TRIVIAL' && isPrMode && taskType !== 'INQUIRY') {
      return 'worker-validator';
    }
    if (complexity === 'TRIVIAL') {
      return 'single-worker';
    }
    if (complexity === 'SIMPLE') {
      return 'worker-validator';
    }
    return 'full-workflow';
  };

  const getLevel = (role: string): ModelLevel => {
    if (complexity === 'CRITICAL' && role === 'planner') return 'level3';
    if (complexity === 'TRIVIAL') return 'level1';
    return 'level2';
  };

  const getValidatorCount = (): number => {
    if (complexity === 'TRIVIAL') return 0;
    if (complexity === 'SIMPLE') return 1;
    if (complexity === 'STANDARD') return 2;
    // CRITICAL uses two-stage validation pipeline (validators loaded dynamically via meta-coordinator)
    // Setting validator_count=0 signals that inline validators should be skipped
    if (complexity === 'CRITICAL') return 0;
    return 1;
  };

  const getMaxTokens = (): number => {
    if (complexity === 'TRIVIAL') return 50000;
    if (complexity === 'SIMPLE') return 100000;
    if (complexity === 'STANDARD') return 100000;
    if (complexity === 'CRITICAL') return 150000;
    return 100000;
  };

  const base = getBase();

  const params: ConfigParams = {
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

export = { getConfig };
