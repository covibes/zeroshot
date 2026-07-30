const BaseProvider = require('./base-provider');
const {
  getProviderMetadata,
  normalizeProviderName,
  resolveProviderCommand,
} = require('../../lib/provider-names');
const { commandExists, getCommandPath } = require('../../lib/provider-detection');
const helper = require('../../lib/agent-cli-provider');

const warned = new Set();

function metadataForProvider(name) {
  return getProviderMetadata(name);
}

class RuntimeProvider extends BaseProvider {
  constructor(name) {
    const normalized = normalizeProviderName(name);
    const metadata = metadataForProvider(normalized);
    super({
      name: normalized,
      displayName: metadata.displayName,
      cliCommand: metadata.binary,
    });
    this._metadata = metadata;
    this._adapter = helper.getProviderAdapter(normalized);
    this._cliFeatures = null;
    this._parserState = this._adapter.createParserState();
  }

  get adapter() {
    return this._adapter;
  }

  isAvailable() {
    if (this._usesBundledRunner()) {
      return helper.probeRuntimeProviderCli(this.name).available;
    }
    const { command } = resolveProviderCommand(this.name);
    if (!commandExists(command)) return false;
    return helper.probeRuntimeProviderCli(this.name).available;
  }

  getCliPath() {
    if (this._usesBundledRunner()) {
      return this._adapter.binary || process.execPath;
    }
    const { command } = resolveProviderCommand(this.name);
    return getCommandPath(command) || command;
  }

  getInstallInstructions() {
    return this._metadata.installInstructions;
  }

  getAuthInstructions() {
    return this._metadata.authInstructions;
  }

  getCliFeatures() {
    if (this._cliFeatures) return this._cliFeatures;
    this._cliFeatures = helper.detectRuntimeProviderCliFeatures(this.name);
    return this._cliFeatures;
  }

  getCredentialPaths() {
    return this._metadata.credentialPaths;
  }

  _usesBundledRunner() {
    return this._adapter.detectCliFeatures('').supportsBundledRunner === true;
  }

  buildCommand(context, options = {}) {
    const prepared = helper.prepareSingleAgentProviderCommand({
      provider: this.name,
      context,
      options,
    });
    this._cliFeatures = prepared.cliFeatures;
    const commandSpec = prepared.commandSpec;
    this._warnCommandSpec(commandSpec);
    return commandSpec;
  }

  _warnCommandSpec(commandSpec) {
    for (const warning of commandSpec.warnings || []) {
      const key = `${warning.provider}:${warning.code}`;
      if (warned.has(key)) continue;
      warned.add(key);
      console.warn(`⚠️ ${warning.message}`);
    }
  }

  parseEvent(line) {
    const event = this._adapter.parseEvent(line, this._parserState);
    return event || null;
  }

  parseChunk(chunk) {
    return parseChunkWithProvider(this, chunk);
  }

  getModelCatalog() {
    return this._adapter.modelCatalog;
  }

  getLevelMapping() {
    return this._adapter.levelMapping;
  }

  getDefaultLevel() {
    return this._adapter.defaultLevel;
  }

  getDefaultMaxLevel() {
    return this._adapter.defaultMaxLevel;
  }

  getDefaultMinLevel() {
    return this._adapter.defaultMinLevel;
  }

  resolveModelSpec(level, overrides = {}) {
    return helper.resolveModelSpec(this.name, level, overrides);
  }

  validateModelId(modelId) {
    return this._adapter.validateModelId(modelId);
  }

  validateConfiguredModelId(modelId) {
    const validator = this._adapter.validateConfiguredModelId || this._adapter.validateModelId;
    return validator(modelId);
  }

  isRetryableError(err) {
    return helper.classifyProviderError(this.name, err).retryable;
  }

  getDefaultSettings() {
    const settings = super.getDefaultSettings();
    if (this._metadata.settingsDefaults) {
      return {
        ...settings,
        ...this._metadata.settingsDefaults,
      };
    }
    if (this._metadata.settingsFields.length === 0) return settings;
    return this._metadata.settingsFields.reduce(
      (result, field) => ({
        ...result,
        [field]: null,
      }),
      { ...settings }
    );
  }

  validateSettings(settings) {
    const baseError = super.validateSettings(settings);
    if (baseError) return baseError;
    if (
      Object.prototype.hasOwnProperty.call(settings, 'webSearch') &&
      !this._metadata.settingsFields.includes('webSearch')
    ) {
      return `Unknown provider setting: providerSettings.${this.name}.webSearch`;
    }
    if (this._metadata.settingsValidator) {
      const providerError = this._metadata.settingsValidator(settings);
      if (providerError) return providerError;
    } else {
      for (const field of this._metadata.settingsFields) {
        if (
          settings[field] !== undefined &&
          settings[field] !== null &&
          typeof settings[field] !== 'string'
        ) {
          return `providerSettings.${this.name}.${field} must be a string or null`;
        }
      }
    }
    if (this.name !== 'claude') return null;

    const { isValidAnthropicKey, ANTHROPIC_KEY_PREFIX } = require('../../lib/settings/claude-auth');
    if (settings.anthropicApiKey && !isValidAnthropicKey(settings.anthropicApiKey)) {
      return `providerSettings.claude.anthropicApiKey must start with ${ANTHROPIC_KEY_PREFIX}`;
    }
    return null;
  }

  getSettingsFields() {
    return [...super.getSettingsFields(), ...this._metadata.settingsFields];
  }
}

function getProvider(name) {
  const normalized = normalizeProviderName(name || '');
  try {
    metadataForProvider(normalized);
  } catch {
    throw new Error(`Unknown provider: ${name}. Valid: ${listProviders().join(', ')}`);
  }
  return new RuntimeProvider(normalized);
}

async function detectProviders() {
  const results = {};
  for (const name of listProviders()) {
    const provider = getProvider(name);
    results[name] = {
      available: await provider.isAvailable(),
    };
  }
  return results;
}

function listProviders() {
  return helper.listProviderAdapters();
}

function stripTimestampPrefix(line) {
  if (!line || typeof line !== 'string') return '';
  let trimmed = line.trim().replace(/\r$/, '');
  if (!trimmed) return '';

  const tsMatch = trimmed.match(/^\[(\d{13})\](.*)$/);
  if (tsMatch) trimmed = (tsMatch[2] || '').trimStart();

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const pipeMatch = trimmed.match(/^[^|]{1,40}\|\s*(.*)$/);
    if (pipeMatch) {
      const afterPipe = (pipeMatch[1] || '').trimStart();
      if (afterPipe.startsWith('{') || afterPipe.startsWith('[')) return afterPipe;
    }
  }

  return trimmed;
}

function collectEvents(events, event) {
  if (!event) return;
  if (Array.isArray(event)) {
    events.push(...event);
    return;
  }
  events.push(event);
}

function parseChunkWithProvider(providerOrName, chunk) {
  if (!chunk) return [];
  const provider =
    typeof providerOrName === 'string' ? getProvider(providerOrName) : providerOrName;
  const events = [];
  const lines = chunk.split('\n');

  for (const line of lines) {
    const content = stripTimestampPrefix(line);
    if (!content) continue;
    collectEvents(events, provider.parseEvent(content));
  }

  return events;
}

function parseProviderChunk(providerName, chunk) {
  return parseChunkWithProvider(providerName || 'claude', chunk);
}

function createProviderClass(name) {
  return class ProviderFacade extends RuntimeProvider {
    constructor() {
      super(name);
    }
  };
}

module.exports = {
  getProvider,
  detectProviders,
  listProviders,
  parseProviderChunk,
  parseChunkWithProvider,
  createProviderClass,
};
