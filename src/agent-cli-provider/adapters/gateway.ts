import path from 'node:path';
import {
  type BuildProviderCommandOptions,
  type CommandSpec,
  type ErrorClassification,
  type GatewayCliFeatures,
  type LevelModelSpec,
  type LevelOverrides,
  type ModelCatalogEntry,
  type ModelLevel,
  type OutputEvent,
  type ProviderAdapter,
  type ProviderParserState,
  type ResolvedModelSpec,
  InvalidProviderModelError,
} from '../types';
import { classifyBaseProviderError, commandSpec, createParserState, envRedactions } from './common';
import { resolveGatewayConfiguration, validateGatewaySettings } from '../gateway-tools';
import { getBoolean, getString, isRecord, tryParseJson } from '../json';

const MODEL_CATALOG: Readonly<Record<string, ModelCatalogEntry>> = {
  'MiniMax-M3': { rank: 3 },
  'MiniMax-M2.7': { rank: 2 },
};

const LEVEL_MAPPING: Readonly<Record<ModelLevel, LevelModelSpec>> = {
  level1: { rank: 1, model: null },
  level2: { rank: 2, model: null },
  level3: { rank: 3, model: null },
};

export const gatewaySettingsDefaults: Readonly<Record<string, unknown>> = Object.freeze({
  protocol: 'openai',
  baseUrl: null,
  apiKey: null,
  headers: null,
  model: null,
  maxTokens: null,
  toolPolicy: null,
});

export { validateGatewaySettings };

function detectCliFeatures(): GatewayCliFeatures {
  return {
    provider: 'gateway',
    supportsBundledRunner: true,
    unknown: false,
  };
}

function buildCommand(context: string, options: BuildProviderCommandOptions = {}): CommandSpec {
  const cwd = options.cwd ?? process.cwd();
  const gateway = resolveGatewayConfiguration(options.gateway, 'options.gateway', cwd);
  const headerEnv = buildGatewayHeaderEnv(gateway.headers);
  const request = {
    context,
    cwd,
    gateway: {
      protocol: gateway.protocol,
      baseUrl: gateway.baseUrl,
      model: gateway.model,
      ...(gateway.maxTokens === undefined ? {} : { maxTokens: gateway.maxTokens }),
      toolPolicy: gateway.toolPolicy,
    },
    ...(Object.keys(headerEnv.mapping).length === 0 ? {} : { gatewayHeaderEnv: headerEnv.mapping }),
  };
  const env = {
    ZEROSHOT_GATEWAY_REQUEST: JSON.stringify(request),
    ZEROSHOT_GATEWAY_API_KEY: gateway.apiKey,
    ...headerEnv.values,
  };

  return commandSpec({
    binary: process.execPath,
    args: [gatewayRunnerPath()],
    env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    redactions: envRedactions(env),
  });
}

function gatewayRunnerPath(): string {
  return path.resolve(__dirname, '..', 'gateway-runner.js');
}

function buildGatewayHeaderEnv(headers: Readonly<Record<string, string>>): {
  readonly mapping: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, string>>;
} {
  const mapping: Record<string, string> = {};
  const values: Record<string, string> = {};
  let index = 0;
  for (const [name, value] of Object.entries(headers)) {
    const envKey = `ZEROSHOT_GATEWAY_HEADER_${index}`;
    index += 1;
    mapping[name] = envKey;
    values[envKey] = value;
  }
  return { mapping, values };
}

function parseEvent(line: string, _state: ProviderParserState): OutputEvent | null {
  const parsed = tryParseJson(line);
  if (!isRecord(parsed)) return null;
  const type = getString(parsed, 'type');
  if (type === 'text') {
    const text = getString(parsed, 'text');
    return text === null ? null : { type: 'text', text };
  }
  if (type === 'tool_call') {
    if (!Object.prototype.hasOwnProperty.call(parsed, 'toolName')) return null;
    return {
      type: 'tool_call',
      toolName: getString(parsed, 'toolName'),
      toolId: getString(parsed, 'toolId'),
      input: parsed.input ?? null,
    };
  }
  if (type === 'tool_result') {
    if (!Object.prototype.hasOwnProperty.call(parsed, 'content')) return null;
    return {
      type: 'tool_result',
      toolId: getString(parsed, 'toolId'),
      content: parsed.content ?? null,
      isError: getBoolean(parsed, 'isError') ?? false,
    };
  }
  if (type === 'result') {
    return {
      type: 'result',
      success: getBoolean(parsed, 'success') ?? false,
      ...(Object.prototype.hasOwnProperty.call(parsed, 'result') ? { result: parsed.result } : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed, 'error') ? { error: parsed.error } : {}),
    };
  }
  return null;
}

function resolveModelSpec(level: ModelLevel, overrides?: LevelOverrides): ResolvedModelSpec {
  const override = overrides?.[level];
  return {
    level,
    model: override?.model ?? null,
    reasoningEffort: override?.reasoningEffort,
  };
}

function validateModelId(modelId: string | null | undefined): string | null | undefined {
  if (modelId === undefined || modelId === null) return modelId;
  const normalized = modelId.trim();
  if (normalized) return normalized;
  throw new InvalidProviderModelError(
    'Invalid model "" for provider "gateway". Use a non-empty model identifier.'
  );
}

function classifyError(error: unknown): ErrorClassification {
  return classifyBaseProviderError(
    error,
    [/rate[_ -]?limit/i, /\b429\b/i, /\b5\d{2}\b/, /\btimed out\b/i],
    [
      /invalid[_ -]?api[_ -]?key/i,
      /\bunauthorized\b/i,
      /\bforbidden\b/i,
      /\bmodel not found\b/i,
      /\bmust be a valid url\b/i,
      /\btoolpolicy\b/i,
      /\bnon-empty model identifier\b/i,
      /\bgateway\.(?:protocol|baseUrl|apiKey|model|maxTokens|toolPolicy)\b/i,
    ]
  );
}

export const gatewayAdapter: ProviderAdapter = {
  id: 'gateway',
  displayName: 'Gateway',
  binary: process.execPath,
  adapterVersion: '1',
  credentialEnvKeys: ['ZEROSHOT_GATEWAY_API_KEY'],
  modelCatalog: MODEL_CATALOG,
  levelMapping: LEVEL_MAPPING,
  defaultLevel: 'level2',
  defaultMaxLevel: 'level3',
  defaultMinLevel: 'level1',
  detectCliFeatures,
  buildCommand,
  parseEvent,
  createParserState: () => createParserState('gateway'),
  resolveModelSpec,
  validateModelId,
  classifyError,
};
