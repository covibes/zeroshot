'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { URL } = require('url');
const { AbortSignal } = global;
const { getSettingsFile, loadSettings } = require('../../lib/settings');
const providerApi = require('../../src/providers');
const {
  compilePrivateOmpModelsYaml,
  detectProviders,
  getProvider,
  parseExactOmpModelSelector,
  resolveOmpSdkSettings,
} = providerApi;
const { resolveOmpSdkRuntime } = require('../../scripts/omp-sdk-runtime');

const OMP_HOST_MARKER = 'ZEROSHOT_OMP_PROVIDER_RESULT ';
const OMP_HOST_ARG = '--omp-sdk-provider-host';

function defaultDeps() {
  return {
    compilePrivateOmpModelsYaml,
    detectProviders,
    env: process.env,
    getProvider,
    getSettingsFile,
    loadSettings,
    parseExactOmpModelSelector,
    resolveOmpSdkRuntime,
    resolveOmpSdkSettings,
    runOmpRegistryOperation,
    spawnSync,
  };
}

function manualConfiguration(settings, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const settingsFile = deps.getSettingsFile();
  const auth = settings?.providerSettings?.omp?.auth;
  let authSource = 'providerSettings.omp.auth (not configured)';
  if (auth?.mode === 'environment') {
    const names = Object.values(auth.credentials || {})
      .map((credential) => credential?.env)
      .filter((name) => typeof name === 'string')
      .sort();
    authSource = `environment variables: ${names.length > 0 ? names.join(', ') : '(none declared)'}`;
  } else if (auth?.mode === 'broker') {
    authSource = `environment variables: ${Object.values(providerApi.OMP_AUTH_BROKER_ENV_NAMES)
      .sort()
      .join(', ')}`;
  } else if (auth?.mode === 'omp-home') {
    authSource =
      typeof auth.path === 'string' && auth.path.length > 0
        ? `${path.join(auth.path, 'agent.db')} (local host only)`
        : 'providerSettings.omp.auth.path (invalid local host path)';
  } else if (auth?.mode === 'none') {
    authSource = 'none (keyless provider)';
  }
  return {
    settingsFile,
    settingsField: 'providerSettings.omp',
    authSource,
    fileMode: '0600',
    directoryMode: '0700',
    reload:
      'Rerun the command or start a new run to reload settings; restart already-running or detached work.',
  };
}

function printManualConfiguration(settings, deps) {
  const manual = manualConfiguration(settings, deps);
  console.log(
    `Configuration: ${manual.settingsFile} (${manual.fileMode}; parent directory ${manual.directoryMode})`
  );
  console.log(`OMP settings field: ${manual.settingsField}`);
  console.log(`Local auth source: ${manual.authSource}`);
  console.log(`Reload: ${manual.reload}`);
}

function manualConfigurationError(error, settings, deps) {
  const manual = manualConfiguration(settings, deps);
  const detail = error instanceof Error ? error.message : 'OMP provider configuration is invalid.';
  return new Error(
    `${detail}\nManually edit ${manual.settingsField} in ${manual.settingsFile}; keep the file ${manual.fileMode} and its parent directory ${manual.directoryMode}. Configure only a local auth source (${manual.authSource}); never store credential values in provider settings. ${manual.reload}`
  );
}

function credentialEvidence(auth, provider, env) {
  if (auth === undefined) {
    return { mode: 'unconfigured', variables: [], configured: false };
  }
  const mode = auth.mode;
  if (mode === 'environment') {
    const variable = auth.credentials?.[provider]?.env || null;
    return {
      mode,
      variables: variable ? [{ name: variable, present: !!env[variable] }] : [],
      configured: variable !== null && !!env[variable],
    };
  }
  if (mode === 'broker') {
    const variables = Object.values(providerApi.OMP_AUTH_BROKER_ENV_NAMES).map((name) => ({
      name,
      present: !!env[name],
    }));
    return {
      mode,
      variables,
      configured: variables.every((entry) => entry.present),
    };
  }
  if (mode === 'omp-home') {
    return {
      mode,
      variables: [],
      configured:
        typeof auth.path === 'string' &&
        auth.path.length > 0 &&
        fs.existsSync(path.join(auth.path, 'agent.db')),
    };
  }
  return { mode: 'none', variables: [], configured: true };
}

function minimalChildEnvironment(env) {
  const childEnv = {};
  if (typeof env.PATH === 'string') childEnv.PATH = env.PATH;
  for (const name of ['SystemRoot', 'WINDIR']) {
    if (typeof env[name] === 'string') childEnv[name] = env[name];
  }
  return childEnv;
}

function credentialChannel(settings, env, operation, levelSelectors, selector) {
  if (operation !== 'validate' && operation !== 'doctor') return { apiKeys: {}, broker: {} };
  const selectedProviders = new Set(
    (operation === 'doctor' ? [{ selector }] : levelSelectors)
      .filter((entry) => typeof entry?.selector === 'string')
      .map((entry) => entry.selector.slice(0, entry.selector.indexOf('/')))
  );
  const apiKeys = {};
  if (settings.auth?.mode === 'environment') {
    for (const [provider, entry] of Object.entries(settings.auth.credentials || {})) {
      const name = entry?.env;
      if (
        selectedProviders.has(provider) &&
        typeof name === 'string' &&
        typeof env[name] === 'string'
      ) {
        apiKeys[provider] = env[name];
      }
    }
  }
  const broker =
    settings.auth?.mode === 'broker'
      ? Object.fromEntries(
          Object.entries(providerApi.OMP_AUTH_BROKER_ENV_NAMES)
            .filter(([, name]) => typeof env[name] === 'string')
            .map(([key, name]) => [key, env[name]])
        )
      : {};
  return { apiKeys, broker };
}

function makePrivateDirectory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-providers-'));
  fs.chmodSync(root, 0o700);
  for (const name of ['home', 'data', 'state', 'cache', 'agent']) {
    fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  }
  return root;
}

function writePrivateJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function authPolicyModulePath() {
  return path.join(__dirname, '..', '..', 'src', 'agent-cli-provider', 'omp-auth-policy.ts');
}

function parseHostResult(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const frames = lines
    .filter((line) => line.startsWith(OMP_HOST_MARKER))
    .map((line) => JSON.parse(line.slice(OMP_HOST_MARKER.length)));
  if (frames.length !== 1) {
    throw new Error('Bundled OMP SDK registry host returned an invalid terminal response');
  }
  if (frames[0].ok !== true) {
    const code = typeof frames[0].code === 'string' ? frames[0].code : 'registry-failed';
    throw new Error(`Bundled OMP SDK registry validation failed (${code})`);
  }
  return frames[0].result;
}

function runOmpRegistryOperation(operation, settings, options = {}, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const runtime = deps.resolveOmpSdkRuntime();
  const root = makePrivateDirectory();
  try {
    const modelsPath = path.join(root, 'models.yml');
    fs.writeFileSync(modelsPath, deps.compilePrivateOmpModelsYaml(settings), {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.chmodSync(modelsPath, 0o600);
    const levelSelectors = Object.entries(settings.levelOverrides || {}).map(
      ([level, override]) => ({ level, selector: override.model })
    );
    const credentialEnvs =
      settings.auth?.mode === 'environment'
        ? Object.fromEntries(
            Object.entries(settings.auth.credentials || {}).map(([provider, credential]) => [
              provider,
              credential.env,
            ])
          )
        : {};

    const authDbPath = path.join(root, 'auth.db');
    const requestPath = path.join(root, 'request.json');
    writePrivateJson(requestPath, {
      operation,
      modelsPath,
      authDbPath,
      brokerCachePath: path.join(root, 'broker-snapshot.json'),
      authPolicyPath: authPolicyModulePath(),
      ompEntryPath: runtime.ompEntryPath,
      selectors: levelSelectors,
      selector: options.selector || null,
      probe: options.probe === true,
      auth: {
        mode: settings.auth?.mode || null,
        credentialEnvs,
        sourcePath: settings.auth?.mode === 'omp-home' ? settings.auth.path : null,
      },
    });

    const child = deps.spawnSync(runtime.bunExecutable, [__filename, OMP_HOST_ARG], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      input: JSON.stringify(
        credentialChannel(settings, deps.env, operation, levelSelectors, options.selector)
      ),
      env: {
        ...minimalChildEnvironment(deps.env),
        HOME: path.join(root, 'home'),
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_STATE_HOME: path.join(root, 'state'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
        PI_CODING_AGENT_DIR: path.join(root, 'agent'),
        TMPDIR: root,
        TMP: root,
        TEMP: root,
        ZEROSHOT_OMP_PROVIDER_REQUEST: requestPath,
      },
    });
    if (child.error) {
      throw new Error('Bundled OMP SDK registry host failed');
    }
    const hostResult = parseHostResult(child.stdout);
    if (child.status !== 0) {
      throw new Error('Bundled OMP SDK registry host returned success with a failing exit status');
    }
    return {
      ...hostResult,
      backendVersion: runtime.ompVersion,
      runtimeVersion: runtime.bunVersion,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function normalizeStoredOmpSettings(settings, deps, context = {}) {
  return deps.resolveOmpSdkSettings(settings, context);
}

function printCredentialEvidence(evidence) {
  console.log(`Auth mode: ${evidence.mode}`);
  if (evidence.variables.length === 0) {
    console.log(`Credential configuration: ${evidence.configured ? 'configured' : 'missing'}`);
    return;
  }
  for (const variable of evidence.variables) {
    console.log(
      `Credential variable: ${variable.name} (${variable.present ? 'present' : 'missing'})`
    );
  }
}

async function providersCommand(_args = [], injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const detected = await deps.detectProviders();
  const settings = deps.loadSettings();

  console.log('\nProvider     Status       Default Level  Model             CLI Path');
  console.log('─'.repeat(70));

  for (const [name, status] of Object.entries(detected)) {
    const provider = deps.getProvider(name);
    const statusIcon = status.available ? '✓ found' : '✗ not found';
    const providerSettings = settings.providerSettings?.[name] || {};
    const defaultLevel = providerSettings.defaultLevel || provider.getDefaultLevel();
    const levelOverrides = providerSettings.levelOverrides || {};
    const modelSpec = provider.resolveModelSpec(defaultLevel, levelOverrides);
    const modelLabel = modelSpec?.model || '-';
    const cliPath = status.available ? await provider.getCliPath() : '-';
    const isDefault = settings.defaultProvider === name ? ' (default)' : '';

    console.log(
      `${provider.displayName.padEnd(12)} ${statusIcon.padEnd(12)} ${defaultLevel.padEnd(
        14
      )} ${modelLabel.padEnd(16)} ${cliPath}${isDefault}`
    );
  }

  console.log('\nRead-only commands:');
  console.log('  zeroshot providers list                    List the isolated OMP registry');
  console.log('  zeroshot providers validate                Validate OMP settings and registry');
  console.log('  zeroshot providers doctor --model <model>  Check exact OMP routing and auth');
  console.log(
    '\nProvider commands never configure providers or credentials. Edit the shared settings file and local auth source manually.'
  );
  printManualConfiguration(settings, deps);
}

function listCommand(_options = {}, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const settings = deps.loadSettings();
  try {
    const ompSettings = normalizeStoredOmpSettings(settings, deps);
    const result = deps.runOmpRegistryOperation('list', ompSettings, {}, deps);
    console.log(`OMP SDK ${result.backendVersion} (Bun ${result.runtimeVersion})`);
    for (const selector of result.selectors) console.log(selector);
    printManualConfiguration(settings, deps);
    return result;
  } catch (error) {
    throw manualConfigurationError(error, settings, deps);
  }
}

function validateCommand(_options = {}, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const settings = deps.loadSettings();
  try {
    const ompSettings = normalizeStoredOmpSettings(settings, deps, {
      executionContext: 'host',
      requireModelConfiguration: true,
    });
    const result = deps.runOmpRegistryOperation('validate', ompSettings, {}, deps);
    console.log(
      `OMP settings valid: ${result.modelCount} models, SDK ${result.backendVersion}, Bun ${result.runtimeVersion}`
    );
    if (ompSettings.auth?.mode === 'environment') {
      for (const provider of Object.keys(ompSettings.auth.credentials || {}).sort()) {
        printCredentialEvidence(credentialEvidence(ompSettings.auth, provider, deps.env));
      }
    } else {
      printCredentialEvidence(credentialEvidence(ompSettings.auth, '', deps.env));
    }
    printManualConfiguration(settings, deps);
    return result;
  } catch (error) {
    throw manualConfigurationError(error, settings, deps);
  }
}

function doctorCommand(modelSelector, options = {}, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const settings = deps.loadSettings();
  try {
    const parsed = deps.parseExactOmpModelSelector(modelSelector);
    const ompSettings = normalizeStoredOmpSettings(settings, deps, {
      executionContext: 'host',
    });
    const auth = credentialEvidence(ompSettings.auth, parsed.provider, deps.env);
    if (!auth.configured) {
      const variables = auth.variables.map((entry) => entry.name).join(', ');
      throw new Error(
        variables
          ? `OMP credential variables are missing: ${variables}`
          : `OMP auth is not configured for provider ${parsed.provider}`
      );
    }
    const result = deps.runOmpRegistryOperation(
      'doctor',
      ompSettings,
      { selector: modelSelector, probe: options.probe === true },
      deps
    );
    if (result.authConfigured !== true) {
      throw new Error(`OMP auth is not configured for provider ${parsed.provider}`);
    }
    console.log(`Requested model: ${modelSelector}`);
    console.log(`Resolved model: ${result.resolvedSelector}`);
    console.log(
      `Provider route: ${result.route.api}${result.route.origin ? ` ${result.route.origin}` : ''}`
    );
    printCredentialEvidence(auth);
    if (options.probe === true) {
      console.log(
        `Network probe: ${result.probe?.reachable ? 'reachable' : result.probe?.status || 'not available'}`
      );
    } else {
      console.log('Network probe: skipped');
    }
    printManualConfiguration(settings, deps);
    return { ...result, auth };
  } catch (error) {
    throw manualConfigurationError(error, settings, deps);
  }
}

function safeRoute(model) {
  let origin = null;
  if (typeof model.baseUrl === 'string') {
    try {
      const parsed = new URL(model.baseUrl);
      origin = parsed.origin;
    } catch {
      origin = null;
    }
  }
  return { api: typeof model.api === 'string' ? model.api : 'provider-native', origin };
}

async function probeRoute(registry, parsed, model) {
  const discoverable = registry.getDiscoverableProviders().includes(parsed.provider);
  if (discoverable) {
    await registry.refreshProvider(parsed.provider, 'online');
    return { attempted: true, reachable: true, status: 'registry-refresh' };
  }
  if (typeof model.baseUrl !== 'string') {
    return { attempted: false, reachable: false, status: 'no-static-url' };
  }
  const response = await fetch(model.baseUrl, {
    method: 'HEAD',
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  return {
    attempted: true,
    reachable: true,
    status: String(response.status),
  };
}

async function runOmpProviderHost() {
  let authStorage;
  process.umask(0o077);
  try {
    const requestPath = process.env.ZEROSHOT_OMP_PROVIDER_REQUEST;
    if (!requestPath) throw new Error('missing-request');
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    const credentials = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const [{ openOmpAuthStorage }, sdk, brokerSdk] = await Promise.all([
      import(require('url').pathToFileURL(request.authPolicyPath).href),
      import(require('url').pathToFileURL(request.ompEntryPath).href),
      import(
        require('url').pathToFileURL(
          path.join(path.dirname(request.ompEntryPath), 'session', 'auth-broker-config.ts')
        ).href
      ),
    ]);
    const authDbPath = request.authDbPath;
    const authMode = request.operation === 'list' ? 'none' : request.auth?.mode;
    authStorage = await openOmpAuthStorage({
      mode: authMode,
      sourceDirectory: authMode === 'omp-home' ? request.auth?.sourcePath : undefined,
      privateAgentDirectory: path.dirname(authDbPath),
      privateDatabasePath: authDbPath,
      brokerCachePath: request.brokerCachePath,
      brokerCredentials: credentials.broker,
      sourceLabel: 'zeroshot omp provider diagnostics',
      createDatabase: (databasePath) => sdk.AuthStorage.create(databasePath),
      discoverBroker: (agentDirectory, options) =>
        brokerSdk.discoverAuthStorage(agentDirectory, options),
    });
    if (request.auth?.mode === 'environment') {
      for (const [provider, credential] of Object.entries(credentials.apiKeys || {})) {
        if (typeof credential === 'string' && credential.length > 0) {
          authStorage.setRuntimeApiKey(provider, credential);
        }
      }
    }
    const registry = new sdk.ModelRegistry(authStorage, request.modelsPath);
    if (registry.getError()) {
      console.log(
        `${OMP_HOST_MARKER}${JSON.stringify({ ok: false, code: 'invalid-models-config' })}`
      );
      process.exitCode = 2;
      return;
    }

    const models = registry.getAll();
    const selectors = models
      .map((model) => `${model.provider}/${model.id}`)
      .sort((left, right) => left.localeCompare(right));
    if (request.operation === 'list') {
      console.log(
        `${OMP_HOST_MARKER}${JSON.stringify({
          ok: true,
          result: { modelCount: selectors.length, selectors },
        })}`
      );
      return;
    }

    if (request.operation === 'validate') {
      const resolvedLevels = [];
      for (const selected of request.selectors || []) {
        if (
          !selected ||
          typeof selected.level !== 'string' ||
          typeof selected.selector !== 'string'
        ) {
          console.log(
            `${OMP_HOST_MARKER}${JSON.stringify({ ok: false, code: 'invalid-selector' })}`
          );
          process.exitCode = 2;
          return;
        }
        const slash = selected.selector.indexOf('/');
        const provider = selected.selector.slice(0, slash);
        const modelId = selected.selector.slice(slash + 1);
        const model = registry.find(provider, modelId);
        if (!model || model.provider !== provider || model.id !== modelId) {
          console.log(
            `${OMP_HOST_MARKER}${JSON.stringify({ ok: false, code: 'model-not-found-exact' })}`
          );
          process.exitCode = 2;
          return;
        }
        if (!registry.hasConfiguredAuth(model)) {
          console.log(
            `${OMP_HOST_MARKER}${JSON.stringify({ ok: false, code: 'auth-not-configured' })}`
          );
          process.exitCode = 2;
          return;
        }
        resolvedLevels.push({
          level: selected.level,
          requestedSelector: selected.selector,
          resolvedSelector: `${model.provider}/${model.id}`,
        });
      }
      console.log(
        `${OMP_HOST_MARKER}${JSON.stringify({
          ok: true,
          result: { modelCount: selectors.length, selectors, resolvedLevels },
        })}`
      );
      return;
    }

    if (request.operation !== 'doctor' || typeof request.selector !== 'string') {
      console.log(`${OMP_HOST_MARKER}${JSON.stringify({ ok: false, code: 'invalid-operation' })}`);
      process.exitCode = 2;
      return;
    }
    const slash = request.selector.indexOf('/');
    const parsed = {
      provider: request.selector.slice(0, slash),
      model: request.selector.slice(slash + 1),
    };
    const model = registry.find(parsed.provider, parsed.model);
    if (!model || model.provider !== parsed.provider || model.id !== parsed.model) {
      console.log(
        `${OMP_HOST_MARKER}${JSON.stringify({ ok: false, code: 'model-not-found-exact' })}`
      );
      process.exitCode = 2;
      return;
    }
    if (!registry.hasConfiguredAuth(model)) {
      console.log(
        `${OMP_HOST_MARKER}${JSON.stringify({ ok: false, code: 'auth-not-configured' })}`
      );
      process.exitCode = 2;
      return;
    }
    const probe = request.probe ? await probeRoute(registry, parsed, model) : null;
    console.log(
      `${OMP_HOST_MARKER}${JSON.stringify({
        ok: true,
        result: {
          resolvedSelector: `${model.provider}/${model.id}`,
          route: safeRoute(model),
          authConfigured: true,
          probe,
        },
      })}`
    );
  } catch {
    console.log(`${OMP_HOST_MARKER}${JSON.stringify({ ok: false, code: 'registry-host-error' })}`);
    process.exitCode = 2;
  } finally {
    if (authStorage) authStorage.close();
  }
}

if (require.main === module && process.argv[2] === OMP_HOST_ARG) {
  runOmpProviderHost();
}

module.exports = {
  credentialEvidence,
  doctorCommand,
  listCommand,
  manualConfiguration,
  providersCommand,
  runOmpRegistryOperation,
  validateCommand,
};
