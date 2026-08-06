import { invalidField } from '../contract-errors';
import { isRecord } from '../json';
import { APIS, ENV_NAME, LEVELS, MODEL_COMPONENT, PROVIDER_FIELDS } from './sdk-settings-constants';
import {
  normalizeCompat,
  normalizeModelDefinition,
  normalizeModelOverride,
} from './sdk-settings-model-fields';
import { parseExactOmpModelSelector } from './sdk-settings-selector';
import type {
  OmpModelsConfig,
  OmpModelLevel,
  OmpLevelOverride,
  OmpProviderConfig,
  OmpSdkAuth,
} from './sdk-settings-types';
import {
  assertProviderId,
  booleanValue,
  emptyHeaders,
  enumValue,
  rejectUnknown,
  safeUrl,
} from './sdk-settings-values';

export function normalizeModelsConfig(value: unknown, auth?: OmpSdkAuth): OmpModelsConfig {
  if (!isRecord(value)) {
    invalidField('providerSettings.omp.modelsConfig', 'OMP modelsConfig must be an object.');
  }
  rejectUnknown(value, new Set(['providers']), 'providerSettings.omp.modelsConfig');
  const providerInput = value.providers ?? {};
  if (!isRecord(providerInput)) {
    invalidField(
      'providerSettings.omp.modelsConfig.providers',
      'OMP modelsConfig.providers must be an object.'
    );
  }
  const providers: Record<string, OmpProviderConfig> = {};
  for (const [provider, config] of Object.entries(providerInput)) {
    const field = `providerSettings.omp.modelsConfig.providers.${provider}`;
    assertProviderId(provider, field);
    providers[provider] = normalizeProviderConfig(provider, config, auth, field);
  }
  return { providers };
}

function normalizeProviderConfig(
  provider: string,
  value: unknown,
  auth: OmpSdkAuth | undefined,
  field: string
): OmpProviderConfig {
  if (!isRecord(value)) invalidField(field, `${field} must be an object.`);
  rejectUnknown(value, PROVIDER_FIELDS, field);
  const result: Record<string, unknown> = {};

  if (value.baseUrl !== undefined) result.baseUrl = safeUrl(value.baseUrl, `${field}.baseUrl`);
  if (value.api !== undefined) result.api = enumValue(value.api, APIS, `${field}.api`);
  if (value.auth !== undefined) {
    const providerAuth = enumValue(
      value.auth,
      ['apiKey', 'none', 'oauth'] as const,
      `${field}.auth`
    );
    if (providerAuth === 'oauth') {
      invalidField(
        `${field}.auth`,
        'Custom provider OAuth would read ambient state and is not accepted.'
      );
    }
    result.auth = providerAuth;
  }
  if (value.transport !== undefined) {
    invalidField(
      `${field}.transport`,
      'Command/gateway-backed custom provider transports are not accepted.'
    );
  }
  if (value.discovery !== undefined) {
    invalidField(`${field}.discovery`, 'Dynamic custom provider discovery is not accepted.');
  }
  if (value.remoteCompaction !== undefined) {
    invalidField(`${field}.remoteCompaction`, 'Remote compaction config is not accepted.');
  }
  if (value.headers !== undefined) result.headers = emptyHeaders(value.headers, `${field}.headers`);
  if (value.compat !== undefined) result.compat = normalizeCompat(value.compat, `${field}.compat`);
  if (value.authHeader !== undefined) {
    result.authHeader = booleanValue(value.authHeader, `${field}.authHeader`);
  }
  if (value.disableStrictTools !== undefined) {
    result.disableStrictTools = booleanValue(
      value.disableStrictTools,
      `${field}.disableStrictTools`
    );
  }

  if (value.models !== undefined) {
    if (!Array.isArray(value.models) || value.models.length === 0) {
      invalidField(`${field}.models`, 'Custom provider models must be a non-empty array.');
    }
    const models = value.models.map((model, index) =>
      normalizeModelDefinition(model, `${field}.models[${index}]`)
    );
    result.models = models;
    if (result.baseUrl === undefined) {
      invalidField(`${field}.baseUrl`, 'baseUrl is required when defining custom models.');
    }
    const hasProviderApi = result.api !== undefined;
    const seenModelIds = new Set<string>();
    for (const { id: modelId } of models) {
      if (seenModelIds.has(modelId)) {
        invalidField(`${field}.models`, `Custom model id ${modelId} is duplicated.`);
      }
      seenModelIds.add(modelId);
    }
    if (!hasProviderApi && models.some((model) => model.api === undefined)) {
      invalidField(
        `${field}.api`,
        'api is required at provider or every model when defining custom models.'
      );
    }
  }

  if (value.modelOverrides !== undefined) {
    if (!isRecord(value.modelOverrides)) {
      invalidField(`${field}.modelOverrides`, 'modelOverrides must be an object.');
    }
    const overrides: Record<string, unknown> = {};
    for (const [model, override] of Object.entries(value.modelOverrides)) {
      if (model.length === 0 || !MODEL_COMPONENT.test(model)) {
        invalidField(`${field}.modelOverrides`, 'modelOverrides keys must be non-empty model IDs.');
      }
      overrides[model] = normalizeModelOverride(override, `${field}.modelOverrides.${model}`);
    }
    result.modelOverrides = overrides;
  }

  const credentialEnv = auth?.mode === 'environment' ? auth.credentials[provider]?.env : undefined;
  if (value.apiKey !== undefined) {
    if (typeof value.apiKey !== 'string' || !ENV_NAME.test(value.apiKey)) {
      invalidField(
        `${field}.apiKey`,
        'apiKey must be an environment variable name; literals and command-backed values are forbidden.'
      );
    }
    if (auth?.mode === 'environment' && credentialEnv === undefined) {
      invalidField(
        `${field}.apiKey`,
        'apiKey must match a declared environment credential reference for this provider.'
      );
    }
    if (credentialEnv !== undefined && value.apiKey !== credentialEnv) {
      invalidField(
        `${field}.apiKey`,
        'apiKey must match the declared environment credential reference.'
      );
    }
    if (auth !== undefined && auth.mode !== 'environment') {
      invalidField(`${field}.apiKey`, `${auth.mode} auth forbids provider apiKey configuration.`);
    }
    result.apiKey = value.apiKey;
  } else if (value.models !== undefined && result.auth !== 'none') {
    if (auth?.mode === 'environment' && credentialEnv !== undefined) {
      result.apiKey = credentialEnv;
    } else if (auth !== undefined) {
      invalidField(
        `${field}.apiKey`,
        'Authenticated custom models require an environment credential reference; broker and omp-home custom-provider credentials cannot be materialized safely.'
      );
    }
  }
  if (auth?.mode === 'none' && result.auth !== 'none') {
    invalidField(
      `${field}.auth`,
      'Keyless settings require custom providers to declare auth: none.'
    );
  }
  return result;
}

export function validateSelectedProviderAuth(
  levels: Readonly<Record<OmpModelLevel, OmpLevelOverride>>,
  modelsConfig: OmpModelsConfig,
  auth: OmpSdkAuth
): void {
  const selectors = LEVELS.map((level) => parseExactOmpModelSelector(levels[level].model));
  const providers = new Set(selectors.map(({ provider }) => provider));
  for (const { provider, model } of selectors) {
    const configuredModels = modelsConfig.providers[provider]?.models;
    if (
      Array.isArray(configuredModels) &&
      !configuredModels.some((configured) => isRecord(configured) && configured.id === model)
    ) {
      invalidField(
        `providerSettings.omp.levelOverrides`,
        `Selected custom model ${provider}/${model} is not declared in modelsConfig.`
      );
    }
  }
  if (auth.mode === 'environment') {
    for (const provider of providers) {
      const custom = modelsConfig.providers[provider];
      if (custom?.auth === 'none') {
        invalidField(
          `providerSettings.omp.auth.mode`,
          `Selected keyless provider ${provider} requires auth mode none.`
        );
      }
      if (auth.credentials[provider] === undefined) {
        invalidField(
          `providerSettings.omp.auth.credentials.${provider}`,
          `Environment auth is missing a credential reference for selected provider ${provider}.`
        );
      }
    }
  }
  if (auth.mode === 'none') {
    for (const provider of providers) {
      const custom = modelsConfig.providers[provider];
      if (custom !== undefined && custom.auth !== 'none') {
        invalidField(
          `providerSettings.omp.modelsConfig.providers.${provider}.auth`,
          `Selected custom provider ${provider} must declare auth: none for keyless execution.`
        );
      }
    }
  }
  if (auth.mode === 'broker') {
    for (const provider of providers) {
      if (modelsConfig.providers[provider]?.models !== undefined) {
        invalidField(
          `providerSettings.omp.modelsConfig.providers.${provider}`,
          'Broker auth cannot safely satisfy OMP custom-provider apiKey config; use environment auth.'
        );
      }
    }
  }
}
