/** Agent configuration validation and defaults. */

import qualityGateSchema = require('./agent-quality-gate-schema');
import settingsFacade = require('./agent-config-settings');

type ModelLevel = 'level1' | 'level2' | 'level3';
type JsonSchemaType = 'array' | 'boolean' | 'integer' | 'number' | 'object' | 'string';

interface JsonSchema {
  type?: JsonSchemaType;
  description?: string;
  enum?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
}

interface ModelRule extends Record<string, unknown> {
  iterations?: unknown;
  model?: string;
  modelLevel?: string;
}

interface PromptRule extends Record<string, unknown> {}

interface PromptOptions extends Record<string, unknown> {
  initial?: string;
  subsequent?: string;
  iterations?: PromptRule[];
  system?: string;
}

interface AgentTrigger extends Record<string, unknown> {
  action?: string;
}

interface AgentConfig extends Record<string, unknown> {
  id: string;
  outputFormat?: string;
  structuredOutput?: JsonSchema;
  jsonSchema?: JsonSchema;
  modelRules?: ModelRule[];
  model?: string;
  modelLevel?: string;
  strictSchema?: boolean;
  prompt?: string | PromptOptions | null;
  timeout?: number | string | null;
  maxIterations?: number;
  staleDuration?: number;
  enableLivenessCheck?: boolean;
  triggers?: AgentTrigger[];
  role?: string;
  requiredQualityGates?: unknown;
  hooks?: {
    onComplete?: {
      config?: {
        content?: {
          data?: {
            qualityGates?: unknown;
            [key: string]: unknown;
          };
        };
      };
    };
  };
}

interface AgentConfigOptions extends Record<string, unknown> {
  mockSpawnFn?: unknown;
  taskRunner?: unknown;
  testMode?: boolean;
}

type SettingsRecord = ReturnType<typeof settingsFacade.loadSettings>;

interface StaticModelConfig {
  type: 'static';
  model: string | null;
  modelLevel: string | null;
}

interface RulesModelConfig {
  type: 'rules';
  rules: ModelRule[];
}

type ModelConfig = StaticModelConfig | RulesModelConfig;
type PromptConfig =
  | { type: 'static'; system: string }
  | { type: 'rules'; rules: PromptRule[] }
  | null;

type NormalizedAgentConfig = Omit<AgentConfig, 'timeout'> & {
  modelConfig: ModelConfig;
  promptConfig: PromptConfig;
  maxIterations: number;
  timeout: number;
  staleDuration: number;
  enableLivenessCheck: boolean;
};

const VALID_LEVELS: readonly ModelLevel[] = ['level1', 'level2', 'level3'];
const DEFAULT_MAX_ITERATIONS = 100;
const DEFAULT_TIMEOUT = 0;
const DEFAULT_STALE_DURATION_MS = 30 * 60 * 1000;
const DEFAULT_LIVENESS_CHECK_ENABLED = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isModelLevel(value: string): value is ModelLevel {
  return value === 'level1' || value === 'level2' || value === 'level3';
}

const { loadSettings, validateModelAgainstMax, VALID_MODELS } = settingsFacade;
const { applyValidatorQualityGateDefaults } = qualityGateSchema;

function applyOutputDefaults(config: AgentConfig): void {
  if (!config.outputFormat) config.outputFormat = 'json';
  if (config.structuredOutput && !config.jsonSchema) config.jsonSchema = config.structuredOutput;
  if (config.outputFormat === 'json' && !config.jsonSchema) {
    config.jsonSchema = {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Brief summary of what was done' },
        result: { type: 'string', description: 'Detailed result or output' },
      },
      required: ['summary', 'result'],
    };
  }
  applyValidatorQualityGateDefaults(config);
}

function buildModelConfig(config: AgentConfig): ModelConfig {
  if (config.modelRules) return { type: 'rules', rules: config.modelRules };
  return { type: 'static', model: config.model || null, modelLevel: config.modelLevel || null };
}

function applyStrictSchemaDefault(config: AgentConfig, settings: SettingsRecord): void {
  if (config.strictSchema === undefined) config.strictSchema = settings.strictSchema !== false;
}

function errorMessage(error: unknown): unknown {
  return isRecord(error) ? error.message : undefined;
}

function validateStaticModelConfig(
  configId: string,
  modelConfig: StaticModelConfig,
  maxModel: string,
  minModel: string | null
): void {
  if (modelConfig.model && VALID_MODELS.includes(modelConfig.model)) {
    try {
      validateModelAgainstMax(modelConfig.model, maxModel, minModel);
    } catch (error: unknown) {
      throw new Error(`Agent "${configId}": ${String(errorMessage(error))}`);
    }
  }
  if (modelConfig.modelLevel && !isModelLevel(modelConfig.modelLevel)) {
    throw new Error(
      `Agent "${configId}": invalid modelLevel "${modelConfig.modelLevel}". Valid: ${VALID_LEVELS.join(', ')}`
    );
  }
}

function validateModelRule(
  configId: string,
  rule: ModelRule,
  maxModel: string,
  minModel: string | null
): void {
  if (rule.model && VALID_MODELS.includes(rule.model)) {
    try {
      validateModelAgainstMax(rule.model, maxModel, minModel);
    } catch {
      throw new Error(
        `Agent "${configId}": modelRule "${String(rule.iterations)}" requests "${rule.model}" ` +
          `but maxModel is "${maxModel}"${minModel ? ` and minModel is "${minModel}"` : ''}. ` +
          `Either adjust the rule's model or change maxModel/minModel settings.`
      );
    }
  }
  if (rule.modelLevel && !isModelLevel(rule.modelLevel)) {
    throw new Error(
      `Agent "${configId}": modelRule "${String(rule.iterations)}" has invalid modelLevel ` +
        `"${rule.modelLevel}". Valid: ${VALID_LEVELS.join(', ')}`
    );
  }
}

function validateModelConfig(
  config: AgentConfig,
  modelConfig: ModelConfig,
  maxModel: string,
  minModel: string | null
): void {
  if (modelConfig.type === 'static') {
    validateStaticModelConfig(config.id, modelConfig, maxModel, minModel);
  } else {
    for (const rule of modelConfig.rules) validateModelRule(config.id, rule, maxModel, minModel);
  }
}

function buildInitialPromptRules(prompt: PromptOptions): PromptRule[] | null {
  if (!prompt.initial && !prompt.subsequent) return null;
  const rules: PromptRule[] = [];
  if (prompt.initial) rules.push({ match: '1', system: prompt.initial });
  if (prompt.subsequent) rules.push({ match: '2+', system: prompt.subsequent });
  return rules;
}

function buildPromptConfig(config: AgentConfig): PromptConfig {
  const prompt = config.prompt;
  if (prompt && typeof prompt !== 'string' && prompt.iterations) {
    return { type: 'rules', rules: prompt.iterations };
  }
  if (prompt && typeof prompt !== 'string') {
    const initialRules = buildInitialPromptRules(prompt);
    if (initialRules) return { type: 'rules', rules: initialRules };
  }
  if (typeof prompt === 'string') return { type: 'static', system: prompt };
  if (prompt?.system) return { type: 'static', system: prompt.system };
  if (prompt) throw new Error(`Agent "${config.id}": invalid prompt format`);
  return null;
}

function normalizeTimeout(config: AgentConfig): number {
  const timeout =
    config.timeout === undefined || config.timeout === null || config.timeout === ''
      ? DEFAULT_TIMEOUT
      : Number(config.timeout);
  config.timeout = timeout;
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new Error(
      `Agent "${config.id}": timeout must be a non-negative number (got ${timeout}).`
    );
  }
  return timeout;
}

function assertTestModeSafety(config: AgentConfig, options: AgentConfigOptions): void {
  const executesTask = config.triggers?.some(
    (trigger) => !trigger.action || trigger.action === 'execute_task'
  );
  if (options.testMode && !options.mockSpawnFn && !options.taskRunner && executesTask) {
    throw new Error(
      `AgentWrapper: testMode=true but no mockSpawnFn/taskRunner provided for agent '${config.id}'. ` +
        `This would cause real Claude API calls. ABORTING.`
    );
  }
}

function validateAgentConfig(
  config: AgentConfig,
  options: AgentConfigOptions = {}
): NormalizedAgentConfig {
  applyOutputDefaults(config);
  const modelConfig = buildModelConfig(config);
  const settings = loadSettings();
  const minModel = settings.minModel || null;
  applyStrictSchemaDefault(config, settings);
  validateModelConfig(config, modelConfig, settings.maxModel, minModel);
  const promptConfig = buildPromptConfig(config);
  const timeout = normalizeTimeout(config);
  assertTestModeSafety(config, options);
  return {
    ...config,
    modelConfig,
    promptConfig,
    maxIterations: config.maxIterations || DEFAULT_MAX_ITERATIONS,
    timeout,
    staleDuration: config.staleDuration || DEFAULT_STALE_DURATION_MS,
    enableLivenessCheck: config.enableLivenessCheck ?? DEFAULT_LIVENESS_CHECK_ENABLED,
  };
}

export = {
  validateAgentConfig,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_STALE_DURATION_MS,
  DEFAULT_LIVENESS_CHECK_ENABLED,
};
