/**
 * AgentConfig - Agent configuration validation and defaults
 *
 * Provides:
 * - Config validation and normalization
 * - Default values for optional fields
 * - Model configuration setup
 * - Safety checks for test mode
 * - maxModel ceiling enforcement at config time
 */

const { loadSettings, validateModelAgainstMax, VALID_MODELS } = require('../../lib/settings');
const { applyValidatorQualityGateDefaults } = require('./agent-quality-gate-schema');

const VALID_LEVELS = ['level1', 'level2', 'level3'];

// Default max iterations (high limit - let the user decide when to give up)
const DEFAULT_MAX_ITERATIONS = 100;

// Default timeout: 0 = no timeout (task runs until completion or explicit kill)
// Use positive number for timeout in milliseconds
const DEFAULT_TIMEOUT = 0;

// Output-silence detection is opt-in because healthy provider operations may be quiet for
// longer than the stale threshold. Explicit task timeouts remain independently supported.
const DEFAULT_STALE_DURATION_MS = 30 * 60 * 1000; // 30 minutes before triggering analysis
const DEFAULT_LIVENESS_CHECK_ENABLED = false;

function applyOutputDefaults(config) {
  // CRITICAL: Enforce JSON schema output by default to prevent parse failures and crashes
  if (!config.outputFormat) {
    config.outputFormat = 'json';
  }

  // Map structuredOutput → jsonSchema (structuredOutput is the user-facing API name,
  // jsonSchema is the internal key used by task executor and CLI args).
  // Explicit jsonSchema takes precedence over structuredOutput.
  if (config.structuredOutput && !config.jsonSchema) {
    config.jsonSchema = config.structuredOutput;
  }

  // If outputFormat is json but no schema defined, use a minimal default schema
  if (config.outputFormat === 'json' && !config.jsonSchema) {
    config.jsonSchema = {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Brief summary of what was done',
        },
        result: {
          type: 'string',
          description: 'Detailed result or output',
        },
      },
      required: ['summary', 'result'],
    };
  }

  applyValidatorQualityGateDefaults(config);
}

function buildModelConfig(config) {
  if (config.modelRules) {
    return { type: 'rules', rules: config.modelRules };
  }
  return {
    type: 'static',
    model: config.model || null,
    modelLevel: config.modelLevel || null,
  };
}

function applyStrictSchemaDefault(config, settings) {
  if (config.strictSchema === undefined) {
    config.strictSchema = settings.strictSchema !== false; // Default true if not set
  }
}

function validateStaticModelConfig(configId, modelConfig, maxModel, minModel) {
  if (modelConfig.model && VALID_MODELS.includes(modelConfig.model)) {
    try {
      validateModelAgainstMax(modelConfig.model, maxModel, minModel);
    } catch (error) {
      throw new Error(`Agent "${configId}": ${error.message}`);
    }
  }

  if (modelConfig.modelLevel && !VALID_LEVELS.includes(modelConfig.modelLevel)) {
    throw new Error(
      `Agent "${configId}": invalid modelLevel "${modelConfig.modelLevel}". ` +
        `Valid: ${VALID_LEVELS.join(', ')}`
    );
  }
}

function validateModelRule(configId, rule, maxModel, minModel) {
  if (rule.model && VALID_MODELS.includes(rule.model)) {
    try {
      validateModelAgainstMax(rule.model, maxModel, minModel);
    } catch {
      throw new Error(
        `Agent "${configId}": modelRule "${rule.iterations}" requests "${rule.model}" ` +
          `but maxModel is "${maxModel}"${minModel ? ` and minModel is "${minModel}"` : ''}. ` +
          `Either adjust the rule's model or change maxModel/minModel settings.`
      );
    }
  }

  if (rule.modelLevel && !VALID_LEVELS.includes(rule.modelLevel)) {
    throw new Error(
      `Agent "${configId}": modelRule "${rule.iterations}" has invalid modelLevel ` +
        `"${rule.modelLevel}". Valid: ${VALID_LEVELS.join(', ')}`
    );
  }
}

function validateModelConfig(config, modelConfig, maxModel, minModel) {
  if (modelConfig.type === 'static') {
    validateStaticModelConfig(config.id, modelConfig, maxModel, minModel);
    return;
  }

  if (modelConfig.type === 'rules') {
    for (const rule of modelConfig.rules) {
      validateModelRule(config.id, rule, maxModel, minModel);
    }
  }
}

function buildInitialPromptRules(prompt) {
  if (prompt?.initial || prompt?.subsequent) {
    const rules = [];
    if (prompt.initial) rules.push({ match: '1', system: prompt.initial });
    if (prompt.subsequent) rules.push({ match: '2+', system: prompt.subsequent });
    return rules;
  }

  return null;
}

function buildPromptConfig(config) {
  const prompt = config.prompt;
  if (prompt?.iterations) {
    return { type: 'rules', rules: prompt.iterations };
  }

  const initialRules = buildInitialPromptRules(prompt);
  if (initialRules) {
    return { type: 'rules', rules: initialRules };
  }

  if (typeof prompt === 'string') {
    return { type: 'static', system: prompt };
  }

  if (prompt?.system) {
    return { type: 'static', system: prompt.system };
  }

  if (prompt) {
    throw new Error(`Agent "${config.id}": invalid prompt format`);
  }

  return null;
}

function normalizeTimeout(config) {
  if (config.timeout === undefined || config.timeout === null || config.timeout === '') {
    config.timeout = DEFAULT_TIMEOUT;
  } else {
    config.timeout = Number(config.timeout);
  }

  if (!Number.isFinite(config.timeout) || config.timeout < 0) {
    throw new Error(
      `Agent "${config.id}": timeout must be a non-negative number (got ${config.timeout}).`
    );
  }

  return config.timeout;
}

function buildNormalizedConfig(config, modelConfig, promptConfig) {
  return {
    ...config,
    modelConfig,
    promptConfig,
    maxIterations: config.maxIterations || DEFAULT_MAX_ITERATIONS,
    timeout: config.timeout,
    staleDuration: config.staleDuration || DEFAULT_STALE_DURATION_MS,
    enableLivenessCheck: config.enableLivenessCheck ?? DEFAULT_LIVENESS_CHECK_ENABLED,
  };
}

function assertTestModeSafety(config, options) {
  const executesTask = config.triggers?.some(
    (trigger) => !trigger.action || trigger.action === 'execute_task'
  );
  const hasMock = options.mockSpawnFn || options.taskRunner;

  if (options.testMode && !hasMock && executesTask) {
    throw new Error(
      `AgentWrapper: testMode=true but no mockSpawnFn/taskRunner provided for agent '${config.id}'. ` +
        `This would cause real Claude API calls. ABORTING.`
    );
  }
}

/**
 * Validate and normalize agent configuration
 * @param {Object} config - Raw agent configuration
 * @param {Object} options - Agent wrapper options
 * @returns {Object} Normalized configuration
 */
function validateAgentConfig(config, options = {}) {
  applyOutputDefaults(config);

  // Model configuration: support both static model and dynamic rules
  // If no model specified, model is null - _selectModel() will use provider defaults
  const modelConfig = buildModelConfig(config);

  // COST CEILING/FLOOR ENFORCEMENT: Validate model(s) against maxModel and minModel at config time
  // Catches violations EARLY (config load) instead of at runtime (iteration N)
  const settings = loadSettings();
  const maxModel = settings.maxModel;
  const minModel = settings.minModel || null;

  // STRICT SCHEMA PROPAGATION: Issue #52 fix
  // If agent config doesn't explicitly set strictSchema, inherit from global settings
  // This allows `zeroshot settings set strictSchema false` to actually affect agents
  // Default behavior: strictSchema=true (reliable JSON output, no streaming)
  applyStrictSchemaDefault(config, settings);
  validateModelConfig(config, modelConfig, maxModel, minModel);

  // Prompt configuration: support static prompt OR iteration-based rules
  // Formats:
  //   prompt: "string"                              -> static
  //   prompt: { system: "string" }                  -> static
  //   prompt: { initial: "...", subsequent: "..." } -> iteration 1 vs 2+
  //   prompt: { iterations: [...] }                 -> full control
  const promptConfig = buildPromptConfig(config);

  // Default timeout to 0 (no timeout) if not specified
  // Use positive number for timeout in milliseconds
  // ROBUST: Handle undefined, null, AND string values from template resolution
  normalizeTimeout(config);

  // Build normalized config
  const normalizedConfig = buildNormalizedConfig(config, modelConfig, promptConfig);

  // SAFETY: In test mode, verify mock is provided for agents that execute tasks
  // Check if this agent executes tasks (vs orchestrator agents that only publish messages)
  assertTestModeSafety(config, options);

  return normalizedConfig;
}

module.exports = {
  validateAgentConfig,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_STALE_DURATION_MS,
  DEFAULT_LIVENESS_CHECK_ENABLED,
};
