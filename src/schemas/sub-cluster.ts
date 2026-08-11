/** Schema validation and defaults for recursively composed sub-clusters. */

type UnknownRecord = Record<string, unknown>;

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface ConfigValidatorModule {
  validateConfig(config: UnknownRecord, depth: number): ValidationResult;
}

interface CompletionHook {
  action?: unknown;
  config?: { topic?: unknown };
}

interface SubClusterAgentConfig {
  id?: unknown;
  type?: unknown;
  config?: UnknownRecord;
  triggers?: unknown[];
  hooks?: { onComplete?: CompletionHook };
  contextStrategy?: { parentTopics?: unknown };
}

const MAX_SUBCLUSTER_DEPTH = 5;

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function isConfigValidatorModule(value: unknown): value is ConfigValidatorModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'validateConfig' in value &&
    typeof value.validateConfig === 'function'
  );
}

function loadConfigValidator(): ConfigValidatorModule {
  // Keep this lazy: config-validator loads this schema while validating agents.
  const configValidator: unknown = require('../config-validator');
  if (!isConfigValidatorModule(configValidator)) {
    throw new TypeError('config-validator must export validateConfig');
  }
  return configValidator;
}

function buildValidationResult(errors: string[], warnings: string[]): ValidationResult {
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function validateSubClusterConfig(
  agentConfig: SubClusterAgentConfig,
  depth: number,
  errors: string[],
  warnings: string[]
): boolean {
  if (!agentConfig.config) {
    errors.push(`Sub-cluster '${String(agentConfig.id)}' missing config field`);
    return false;
  }

  if (!agentConfig.config.agents || !Array.isArray(agentConfig.config.agents)) {
    errors.push(`Sub-cluster '${String(agentConfig.id)}' config.agents must be an array`);
    return false;
  }

  if (agentConfig.config.agents.length === 0) {
    errors.push(`Sub-cluster '${String(agentConfig.id)}' config.agents cannot be empty`);
    return false;
  }

  const childValidation = loadConfigValidator().validateConfig(agentConfig.config, depth + 1);

  if (!childValidation.valid) {
    errors.push(
      ...childValidation.errors.map((error) => `Sub-cluster '${String(agentConfig.id)}': ${error}`)
    );
  }

  warnings.push(
    ...childValidation.warnings.map(
      (warning) => `Sub-cluster '${String(agentConfig.id)}': ${warning}`
    )
  );
  return true;
}

function validateSubClusterTriggers(agentConfig: SubClusterAgentConfig, errors: string[]): void {
  if (!agentConfig.triggers || agentConfig.triggers.length === 0) {
    errors.push(`Sub-cluster '${String(agentConfig.id)}' must have triggers to activate`);
  }
}

function validateSubClusterHooks(agentConfig: SubClusterAgentConfig, errors: string[]): void {
  if (!agentConfig.hooks?.onComplete) {
    return;
  }

  const hook = agentConfig.hooks.onComplete;
  if (!hook.action) {
    errors.push(`Sub-cluster '${String(agentConfig.id)}' onComplete hook missing action`);
  }
  if (hook.action === 'publish_message' && !hook.config?.topic) {
    errors.push(`Sub-cluster '${String(agentConfig.id)}' onComplete hook missing config.topic`);
  }
}

function validateContextStrategy(agentConfig: SubClusterAgentConfig, errors: string[]): void {
  const parentTopics = agentConfig.contextStrategy?.parentTopics;
  if (!parentTopics) {
    return;
  }

  if (!Array.isArray(parentTopics)) {
    errors.push(
      `Sub-cluster '${String(agentConfig.id)}' contextStrategy.parentTopics must be an array`
    );
    return;
  }

  const allowedStrategies: unknown[] = ['latest', 'all', 'oldest'];
  for (const entry of parentTopics) {
    if (typeof entry === 'string') {
      continue;
    }

    if (!isUnknownRecord(entry)) {
      errors.push(
        `Sub-cluster '${String(agentConfig.id)}' parentTopics must contain strings or objects, got ${typeof entry}`
      );
      continue;
    }

    if (typeof entry.topic !== 'string') {
      errors.push(
        `Sub-cluster '${String(agentConfig.id)}' parentTopics entry must include a string topic`
      );
    }

    if (entry.strategy && !allowedStrategies.includes(entry.strategy)) {
      errors.push(
        `Sub-cluster '${String(agentConfig.id)}' parentTopics entry has invalid strategy '${String(entry.strategy)}'`
      );
    }

    if (
      entry.amount !== undefined &&
      (typeof entry.amount !== 'number' || !Number.isFinite(entry.amount))
    ) {
      errors.push(
        `Sub-cluster '${String(agentConfig.id)}' parentTopics entry amount must be a number`
      );
    }

    if (
      entry.limit !== undefined &&
      (typeof entry.limit !== 'number' || !Number.isFinite(entry.limit))
    ) {
      errors.push(
        `Sub-cluster '${String(agentConfig.id)}' parentTopics entry limit must be a number`
      );
    }
  }
}

function validateSubCluster(agentConfig: SubClusterAgentConfig, depth = 0): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (depth > MAX_SUBCLUSTER_DEPTH) {
    errors.push(
      `Sub-cluster '${String(agentConfig.id)}' exceeds max nesting depth (${MAX_SUBCLUSTER_DEPTH})`
    );
    return buildValidationResult(errors, warnings);
  }

  if (agentConfig.type !== 'subcluster') {
    errors.push(`Agent '${String(agentConfig.id)}' must have type: 'subcluster'`);
  }

  if (!validateSubClusterConfig(agentConfig, depth, errors, warnings)) {
    return buildValidationResult(errors, warnings);
  }

  validateSubClusterTriggers(agentConfig, errors);
  validateSubClusterHooks(agentConfig, errors);
  validateContextStrategy(agentConfig, errors);

  return buildValidationResult(errors, warnings);
}

function getDefaultSubCluster(): UnknownRecord {
  return {
    id: 'example-subcluster',
    type: 'subcluster',
    role: 'orchestrator',
    config: {
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          triggers: [{ topic: 'PARENT_TRIGGER' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'WORK_COMPLETE' },
            },
          },
        },
      ],
    },
    triggers: [{ topic: 'START_WORK' }],
    hooks: {
      onComplete: {
        action: 'publish_message',
        config: { topic: 'SUBCLUSTER_COMPLETE' },
      },
    },
    contextStrategy: {
      parentTopics: ['ISSUE_OPENED', 'PLAN_READY'],
    },
  };
}

export = {
  validateSubCluster,
  getDefaultSubCluster,
};
