const path = require('path');
const { spawnSync } = require('child_process');
const chalk = require('chalk');
const { normalizeProviderName, getDefaultProviderId } = require('./provider-names');
const { getProvider } = require('../src/providers');
const { detectProvider } = require('../src/issue-providers');
const TemplateResolver = require('../src/template-resolver');
const { runModeFromPlan } = require('./run-mode');
const { resolveRunPlan } = require('./run-plan');

const PACKAGE_ROOT = path.resolve(__dirname, '..');

function firstTruthy(...values) {
  return values.find(Boolean);
}
function anyTruthy(...values) {
  return values.some(Boolean);
}
function optionalValue(value) {
  return value || undefined;
}
function resolveTargetCwd() {
  return firstTruthy(process.env.ZEROSHOT_CWD, detectGitRepoRoot());
}

function detectGitRepoRoot() {
  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      return process.cwd();
    }
    return result.stdout.trim();
  } catch {
    return process.cwd();
  }
}

function resolveOptionalString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveEnvBool(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '1' || trimmed === 'true' || trimmed === 'yes') return true;
  if (trimmed === '0' || trimmed === 'false' || trimmed === 'no') return false;
  return undefined;
}

function resolveCloseIssueMode(value) {
  const trimmed = resolveOptionalString(value);
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  if (normalized === 'auto' || normalized === 'always' || normalized === 'never') {
    return normalized;
  }
  return undefined;
}

function parseRunOptionsEnv() {
  const raw = resolveOptionalString(process.env.ZEROSHOT_RUN_OPTIONS);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseMountSpecs(specs) {
  return specs.map((spec) => {
    const parts = spec.split(':');
    if (parts.length < 2) {
      throw new Error(`Invalid mount spec: "${spec}". Format: host:container[:ro]`);
    }
    const host = parts[0];
    const container = parts[1];
    const readonly = parts[2] === 'ro';
    return { host, container, readonly };
  });
}

function buildTextInput(text) {
  return { text };
}
function buildIssueInput(issue) {
  return { issue };
}
function buildFileInput(file) {
  return { file };
}

function detectRunInput(inputArg, settings = {}, forceProvider = null) {
  const isMarkdownFile = /\.(md|markdown)$/i.test(inputArg);
  if (isMarkdownFile) {
    return buildFileInput(inputArg);
  }

  const ProviderClass = detectProvider(inputArg, settings, forceProvider);
  if (ProviderClass) {
    return buildIssueInput(inputArg);
  }

  return buildTextInput(inputArg);
}

const STDIN_MARKER = '-';

function isStdinInput(inputArg) {
  return inputArg === STDIN_MARKER;
}

async function readStdinText(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))))
    .toString('utf8')
    .trim();
}

function encodeStdinEnv(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decodeStdinEnv(value) {
  return Buffer.from(value, 'base64').toString('utf8');
}

function resolveProviderOverride(options = {}) {
  const override = options.provider || options.envProvider || process.env.ZEROSHOT_PROVIDER;
  if (!override || (typeof override === 'string' && !override.trim())) {
    return null;
  }
  const normalized = normalizeProviderName(override);
  if (options.validateProvider) {
    getProvider(normalized);
  }
  return normalized;
}

function resolveConfigPath(configName) {
  if (path.isAbsolute(configName) || configName.startsWith('./') || configName.startsWith('../')) {
    return path.resolve(process.cwd(), configName);
  }
  if (configName.endsWith('.json')) {
    return path.join(PACKAGE_ROOT, 'cluster-templates', configName);
  }
  return path.join(PACKAGE_ROOT, 'cluster-templates', `${configName}.json`);
}

function ensureConfigProviderDefaults(config, settings) {
  if (!config.defaultProvider) {
    config.defaultProvider = settings.defaultProvider || getDefaultProviderId();
  }
  config.defaultProvider = normalizeProviderName(config.defaultProvider) || getDefaultProviderId();
}

function applyProviderOverrideToConfig(config, providerOverride, settings) {
  const provider = getProvider(providerOverride);
  const providerSettings = settings.providerSettings?.[providerOverride] || {};
  config.forceProvider = providerOverride;
  config.defaultProvider = providerOverride;
  config.forceLevel = providerSettings.defaultLevel || provider.getDefaultLevel();
  config.defaultLevel = config.forceLevel;
  console.log(chalk.dim(`Provider override: ${providerOverride} (all agents)`));
}

function resolveParameterizedConfigFile(config) {
  if (!config?.params || Object.keys(config.params).length === 0) {
    return config;
  }

  const resolver = new TemplateResolver(path.join(PACKAGE_ROOT, 'cluster-templates'));
  return resolver.resolveTemplate(config, {});
}

function prepareClusterConfig(config, settings = {}, providerOverride) {
  const prepared = resolveParameterizedConfigFile(config);
  ensureConfigProviderDefaults(prepared, settings);
  if (providerOverride) {
    applyProviderOverrideToConfig(prepared, providerOverride, settings);
  }
  return prepared;
}

function loadClusterConfig(orchestrator, configPath, settings = {}, providerOverride) {
  return prepareClusterConfig(orchestrator.loadConfig(configPath), settings, providerOverride);
}

const RUN_MODE_KEYS = ['docker', 'worktree', 'pr', 'ship', 'noIsolation', 'isolation'];

function hasExplicitRunMode(options) {
  return RUN_MODE_KEYS.some(
    (key) => options[key] === true || (key === 'isolation' && options[key] === false)
  );
}

function mergeRunOptions(options) {
  const envRunOptions = parseRunOptionsEnv();
  if (!envRunOptions) return options;
  if (!hasExplicitRunMode(options)) return { ...envRunOptions, ...options };
  const withoutEnvMode = { ...envRunOptions };
  for (const key of RUN_MODE_KEYS) delete withoutEnvMode[key];
  return { ...withoutEnvMode, ...options };
}

function validateSavedRunModes(settings) {
  const isolation = settings.defaultIsolation || 'none';
  const delivery = settings.defaultDelivery || 'none';
  if (!['none', 'worktree', 'docker'].includes(isolation)) {
    throw new Error(`Invalid saved isolation mode: ${isolation}`);
  }
  if (!['none', 'pr', 'ship'].includes(delivery)) {
    throw new Error(`Invalid saved delivery mode: ${delivery}`);
  }
  return { isolation, delivery };
}

function resolveEffectiveIsolation(options, savedIsolation) {
  if (options.noIsolation === true || options.isolation === false) return 'none';
  if (options.docker === true) return 'docker';
  if (options.worktree === true || options.pr === true || options.ship === true) return 'worktree';
  if (resolveEnvBool(process.env.ZEROSHOT_DOCKER) === true) return 'docker';
  if (resolveEnvBool(process.env.ZEROSHOT_WORKTREE) === true) return 'worktree';
  return savedIsolation;
}

function resolveEffectiveDelivery(options, savedDelivery) {
  if (options.ship === true || options.autoMerge === true) return 'ship';
  if (options.pr === true || resolveEnvBool(process.env.ZEROSHOT_PR) === true) return 'pr';
  return savedDelivery;
}

function resolveEffectiveRunPlan(options = {}, settings = {}) {
  const mergedOptions = mergeRunOptions(options);
  const noIsolation = mergedOptions.noIsolation === true || mergedOptions.isolation === false;
  const conflicts = ['docker', 'worktree', 'pr', 'ship'].filter(
    (key) => mergedOptions[key] === true
  );
  if (noIsolation && conflicts.length > 0) {
    throw new Error(`--no-isolation conflicts with --${conflicts.join(', --')}`);
  }

  const saved = validateSavedRunModes(settings);
  let isolation = resolveEffectiveIsolation(mergedOptions, saved.isolation);
  const delivery = resolveEffectiveDelivery(mergedOptions, saved.delivery);
  if (delivery !== 'none' && isolation === 'none') {
    if (noIsolation) {
      throw new Error(`--no-isolation conflicts with saved delivery mode "${delivery}"`);
    }
    isolation = 'worktree';
  }
  return resolveRunPlan({
    docker: isolation === 'docker',
    worktree: isolation === 'worktree',
    pr: delivery === 'pr',
    ship: delivery === 'ship',
  });
}

function resolveMergeQueue(mergedOptions) {
  if (typeof mergedOptions.mergeQueue === 'boolean') {
    return mergedOptions.mergeQueue;
  }
  return resolveEnvBool(process.env.ZEROSHOT_MERGE_QUEUE);
}

function resolvePrBase(mergedOptions) {
  return (
    resolveOptionalString(mergedOptions.prBase) ||
    resolveOptionalString(process.env.ZEROSHOT_PR_BASE) ||
    undefined
  );
}

function resolveCloseIssue(mergedOptions) {
  return (
    resolveCloseIssueMode(mergedOptions.closeIssue) ||
    resolveCloseIssueMode(process.env.ZEROSHOT_CLOSE_ISSUE) ||
    undefined
  );
}

function resolveMounts(mergedOptions) {
  return mergedOptions.mount ? parseMountSpecs(mergedOptions.mount) : undefined;
}

function buildStartOptions({
  clusterId,
  options = {},
  settings = {},
  providerOverride,
  modelOverride,
  forceProvider,
}) {
  const mergedOptions = mergeRunOptions(options);
  const plan = resolveEffectiveRunPlan(options, settings);
  return buildStartOptionsFromPlan({
    clusterId,
    plan,
    options: mergedOptions,
    settings,
    providerOverride,
    modelOverride,
    forceProvider,
    environment: true,
  });
}

function buildStartOptionsFromPlan({
  clusterId,
  plan,
  options,
  settings,
  providerOverride,
  modelOverride,
  forceProvider,
  environment,
}) {
  const targetCwd = environment ? resolveTargetCwd() : options.cwd;
  return Object.freeze({
    clusterId,
    cwd: targetCwd,
    isolation: plan.isolation === 'docker',
    isolationImage: environment
      ? firstTruthy(options.dockerImage, process.env.ZEROSHOT_DOCKER_IMAGE)
      : optionalValue(options.dockerImage),
    worktree: plan.isolation === 'worktree',
    autoPr: plan.delivery !== 'none',
    autoMerge: plan.autoMerge,
    autoPush: environment ? process.env.ZEROSHOT_PUSH === '1' : options.autoPush === true,
    modelOverride: optionalValue(modelOverride),
    providerOverride: optionalValue(providerOverride),
    noMounts: anyTruthy(options.mounts === false, options.noMounts === true),
    mounts: resolveMounts(options),
    containerHome: optionalValue(options.containerHome),
    forceProvider: optionalValue(forceProvider),
    prBase: environment ? resolvePrBase(options) : optionalValue(options.prBase),
    mergeQueue: environment ? resolveMergeQueue(options) : optionalValue(options.mergeQueue),
    closeIssue: environment ? resolveCloseIssue(options) : optionalValue(options.closeIssue),
    ship: plan.delivery === 'ship',
    runMode: runModeFromPlan(plan),
    requiredQualityGates: options.requiredQualityGates,
    settings,
  });
}

/**
 * Build start options from a registry-owned canonical plan. Unlike the CLI
 * builder, this function never reads ZEROSHOT_RUN_OPTIONS or mode-related
 * environment variables. The caller must resolve and validate the deployment
 * profile before invoking it.
 */
function buildTrustedStartOptions({
  clusterId,
  plan,
  options = {},
  settings = {},
  providerOverride,
  forceProvider,
}) {
  if (!plan || !Object.isFrozen(plan)) {
    throw new Error('Trusted start requires a frozen canonical run plan');
  }
  const canonical = resolveRunPlan({
    docker: plan.isolation === 'docker',
    worktree: plan.isolation === 'worktree',
    pr: plan.delivery === 'pr',
    ship: plan.delivery === 'ship',
  });
  if (
    canonical.isolation !== plan.isolation ||
    canonical.delivery !== plan.delivery ||
    canonical.autoMerge !== plan.autoMerge
  ) {
    throw new Error('Trusted start plan is not canonical');
  }
  if (canonical.isolation === 'none') {
    throw new Error('Trusted worker start requires worktree or docker isolation');
  }
  return buildStartOptionsFromPlan({
    clusterId,
    plan: canonical,
    options,
    settings,
    providerOverride,
    forceProvider,
    environment: false,
  });
}

function resolveConfigOrThrow({
  orchestrator,
  config,
  configPath,
  configName,
  settings,
  providerOverride,
}) {
  if (config) {
    return config;
  }
  const resolvedPath = configPath || (configName ? resolveConfigPath(configName) : null);
  if (!resolvedPath) {
    throw new Error('configPath or configName is required when config is not provided');
  }
  return loadClusterConfig(orchestrator, resolvedPath, settings, providerOverride);
}

function startClusterWithInput(args, input) {
  const { orchestrator, config, configPath, configName, settings, providerOverride } = args;
  if (!orchestrator) {
    throw new Error('orchestrator is required');
  }
  const resolvedConfig = resolveConfigOrThrow({
    orchestrator,
    config,
    configPath,
    configName,
    settings,
    providerOverride,
  });
  const startOptions = buildStartOptions({
    clusterId: args.clusterId,
    options: args.options || {},
    settings,
    providerOverride,
    modelOverride: args.modelOverride,
    forceProvider: args.forceProvider,
  });
  return orchestrator.start(resolvedConfig, input, startOptions);
}

function startClusterFromText(args) {
  return startClusterWithInput(args, buildTextInput(args.text));
}

function startClusterFromIssue(args) {
  return startClusterWithInput(args, buildIssueInput(args.issue));
}

function startClusterFromFile(args) {
  return startClusterWithInput(args, buildFileInput(args.file));
}

module.exports = {
  buildTextInput,
  buildIssueInput,
  buildFileInput,
  detectRunInput,
  isStdinInput,
  readStdinText,
  encodeStdinEnv,
  decodeStdinEnv,
  resolveProviderOverride,
  resolveConfigPath,
  prepareClusterConfig,
  loadClusterConfig,
  buildStartOptions,
  buildTrustedStartOptions,
  resolveEffectiveRunPlan,
  startClusterFromText,
  startClusterFromIssue,
  startClusterFromFile,
  detectGitRepoRoot,
};
