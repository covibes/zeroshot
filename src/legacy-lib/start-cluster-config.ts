import path = require('path');

interface ClusterConfig extends Record<string, unknown> {
  defaultLevel?: unknown;
  defaultProvider?: string;
  forceLevel?: unknown;
  forceProvider?: string;
  params?: Record<string, unknown>;
}

interface ProviderSettings {
  defaultLevel?: unknown;
}

interface Settings {
  defaultProvider?: string;
  providerSettings?: Record<string, ProviderSettings>;
}

interface ProviderNamesFacade {
  getDefaultProviderId(): string;
  normalizeProviderName(name: string): string;
}

interface ProviderFacade {
  getDefaultLevel(): unknown;
}

interface ProvidersFacade {
  getProvider(providerId: string): ProviderFacade;
}

interface TemplateResolverFacade {
  resolveTemplate(config: ClusterConfig, params: Record<string, unknown>): ClusterConfig;
}

interface TemplateResolverConstructor {
  new (templatesRoot: string): TemplateResolverFacade;
}

interface OrchestratorFacade {
  loadConfig(configPath: string): ClusterConfig;
}

interface ChalkFacade {
  dim(message: string): string;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const chalk: ChalkFacade = require('chalk');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const providerNames: ProviderNamesFacade = require('./provider-names');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const providers: ProvidersFacade = require('../src/providers');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const TemplateResolver: TemplateResolverConstructor = require('../src/template-resolver');

const { normalizeProviderName, getDefaultProviderId } = providerNames;
const { getProvider } = providers;
const PACKAGE_ROOT = path.resolve(__dirname, '..');

function resolveConfigPath(configName: string): string {
  if (path.isAbsolute(configName) || configName.startsWith('./') || configName.startsWith('../')) {
    return path.resolve(process.cwd(), configName);
  }
  if (configName.endsWith('.json')) {
    return path.join(PACKAGE_ROOT, 'cluster-templates', configName);
  }
  return path.join(PACKAGE_ROOT, 'cluster-templates', `${configName}.json`);
}

function ensureConfigProviderDefaults(config: ClusterConfig, settings: Settings): void {
  if (!config.defaultProvider) {
    config.defaultProvider = settings.defaultProvider || getDefaultProviderId();
  }
  config.defaultProvider = normalizeProviderName(config.defaultProvider) || getDefaultProviderId();
}

function applyProviderOverrideToConfig(
  config: ClusterConfig,
  providerOverride: string,
  settings: Settings
): void {
  const provider = getProvider(providerOverride);
  const providerSettings = settings.providerSettings?.[providerOverride] || {};
  config.forceProvider = providerOverride;
  config.defaultProvider = providerOverride;
  config.forceLevel = providerSettings.defaultLevel || provider.getDefaultLevel();
  config.defaultLevel = config.forceLevel;
  console.log(chalk.dim(`Provider override: ${providerOverride} (all agents)`));
}

function resolveParameterizedConfigFile(config: ClusterConfig): ClusterConfig {
  if (!config?.params || Object.keys(config.params).length === 0) {
    return config;
  }

  const resolver = new TemplateResolver(path.join(PACKAGE_ROOT, 'cluster-templates'));
  return resolver.resolveTemplate(config, {});
}

function prepareClusterConfig(
  config: ClusterConfig,
  settings: Settings = {},
  providerOverride?: string | null
): ClusterConfig {
  const prepared = resolveParameterizedConfigFile(config);
  ensureConfigProviderDefaults(prepared, settings);
  if (providerOverride) {
    applyProviderOverrideToConfig(prepared, providerOverride, settings);
  }
  return prepared;
}

function loadClusterConfig(
  orchestrator: OrchestratorFacade,
  configPath: string,
  settings: Settings = {},
  providerOverride?: string | null
): ClusterConfig {
  return prepareClusterConfig(orchestrator.loadConfig(configPath), settings, providerOverride);
}

export = { resolveConfigPath, prepareClusterConfig, loadClusterConfig };
