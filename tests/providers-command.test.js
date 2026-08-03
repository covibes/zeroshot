'use strict';

const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const path = require('path');
const { expect } = require('chai');
const providerCommands = require('../cli/commands/providers');
const {
  credentialEvidence,
  doctorCommand,
  listCommand,
  manualConfiguration,
  runOmpRegistryOperation,
  validateCommand,
} = providerCommands;

function ompSettings(
  auth = {
    mode: 'environment',
    credentials: { 'amazon-bedrock': { env: 'AWS_BEARER_TOKEN_BEDROCK' } },
  }
) {
  return {
    transport: 'sdk',
    minLevel: 'level1',
    defaultLevel: 'level2',
    maxLevel: 'level3',
    levelOverrides: {
      level1: { model: 'amazon-bedrock/model-a', reasoningEffort: 'max' },
      level2: { model: 'amazon-bedrock/model-a', reasoningEffort: 'max' },
      level3: { model: 'amazon-bedrock/model-a', reasoningEffort: 'max' },
    },
    modelsConfig: { providers: {} },
    auth,
    tools: ['read'],
    nestedAgents: false,
    mcp: false,
  };
}

function captureLogs(run) {
  const original = console.log;
  const lines = [];
  console.log = (...values) => lines.push(values.join(' '));
  try {
    return { value: run(), output: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

describe('providers command OMP contracts', () => {
  it('reports credential presence by variable name without exposing its value', () => {
    const evidence = credentialEvidence(
      {
        mode: 'environment',
        credentials: { provider: { env: 'PROVIDER_API_KEY' } },
      },
      'provider',
      { PROVIDER_API_KEY: 'do-not-print-this-value' }
    );

    expect(evidence).to.deep.equal({
      mode: 'environment',
      variables: [{ name: 'PROVIDER_API_KEY', present: true }],
      configured: true,
    });
    expect(JSON.stringify(evidence)).not.to.include('do-not-print-this-value');
  });

  it('treats empty broker variables as missing while preserving explicit keyless auth', () => {
    const broker = credentialEvidence({ mode: 'broker' }, 'provider', {
      OMP_AUTH_BROKER_URL: '',
      OMP_AUTH_BROKER_TOKEN: '',
    });
    expect(broker.configured).to.equal(false);
    expect(broker.variables).to.deep.equal([
      { name: 'OMP_AUTH_BROKER_URL', present: false },
      { name: 'OMP_AUTH_BROKER_TOKEN', present: false },
    ]);
    expect(credentialEvidence({ mode: 'none' }, 'provider', {}).configured).to.equal(true);
  });

  it('lists through the isolated SDK registry operation', () => {
    const calls = [];
    const result = captureLogs(() =>
      listCommand(
        {},
        {
          loadSettings: () => ({ providerSettings: { omp: ompSettings() } }),
          resolveOmpSdkSettings: (settings) => settings.providerSettings.omp,
          runOmpRegistryOperation: (operation, settings, options) => {
            calls.push({ operation, settings, options });
            return {
              selectors: ['amazon-bedrock/model-a'],
              modelCount: 1,
              backendVersion: '17.2.1',
              runtimeVersion: '1.3.14',
            };
          },
        }
      )
    );

    expect(calls).to.have.length(1);
    expect(calls[0].operation).to.equal('list');
    expect(result.output).to.include('amazon-bedrock/model-a');
  });

  it('validates without disclosing credential values', () => {
    const secret = 'credential-value-must-not-appear';
    const result = captureLogs(() =>
      validateCommand(
        {},
        {
          env: { AWS_BEARER_TOKEN_BEDROCK: secret },
          loadSettings: () => ({ providerSettings: { omp: ompSettings() } }),
          resolveOmpSdkSettings: (settings) => settings.providerSettings.omp,
          runOmpRegistryOperation: () => ({
            selectors: ['amazon-bedrock/model-a'],
            modelCount: 1,
            backendVersion: '17.2.1',
            runtimeVersion: '1.3.14',
          }),
        }
      )
    );

    expect(result.output).to.include('AWS_BEARER_TOKEN_BEDROCK (present)');
    expect(result.output).not.to.include(secret);
  });

  it('doctors an exact selector without probing by default', () => {
    const calls = [];
    const secret = 'private-provider-token';
    const result = captureLogs(() =>
      doctorCommand(
        'amazon-bedrock/model-a',
        {},
        {
          env: { AWS_BEARER_TOKEN_BEDROCK: secret },
          loadSettings: () => ({ providerSettings: { omp: ompSettings() } }),
          resolveOmpSdkSettings: (settings) => settings.providerSettings.omp,
          parseExactOmpModelSelector: () => ({ provider: 'amazon-bedrock', model: 'model-a' }),
          runOmpRegistryOperation: (operation, settings, options) => {
            calls.push({ operation, settings, options });
            return {
              resolvedSelector: 'amazon-bedrock/model-a',
              authConfigured: true,
              route: { api: 'bedrock-converse-stream', origin: null },
              probe: null,
              backendVersion: '17.2.1',
              runtimeVersion: '1.3.14',
            };
          },
        }
      )
    );

    expect(calls[0].operation).to.equal('doctor');
    expect(calls[0].options.probe).to.equal(false);
    expect(result.output).to.include('Network probe: skipped');
    expect(result.output).not.to.include(secret);
  });

  it('passes an explicit probe decision to the isolated registry operation', () => {
    const calls = [];
    captureLogs(() =>
      doctorCommand(
        'amazon-bedrock/model-a',
        { probe: true },
        {
          env: { AWS_BEARER_TOKEN_BEDROCK: 'secret' },
          loadSettings: () => ({ providerSettings: { omp: ompSettings() } }),
          resolveOmpSdkSettings: (settings) => settings.providerSettings.omp,
          parseExactOmpModelSelector: () => ({ provider: 'amazon-bedrock', model: 'model-a' }),
          runOmpRegistryOperation: (_operation, _settings, options) => {
            calls.push(options);
            return {
              resolvedSelector: 'amazon-bedrock/model-a',
              authConfigured: true,
              route: { api: 'bedrock-converse-stream', origin: null },
              probe: { attempted: true, reachable: true, status: '200' },
            };
          },
        }
      )
    );

    expect(calls[0].probe).to.equal(true);
  });

  it('fails doctor before registry access when the declared credential is absent', () => {
    let called = false;
    expect(() =>
      doctorCommand(
        'amazon-bedrock/model-a',
        {},
        {
          env: {},
          loadSettings: () => ({ providerSettings: { omp: ompSettings() } }),
          resolveOmpSdkSettings: (settings) => settings.providerSettings.omp,
          parseExactOmpModelSelector: () => ({ provider: 'amazon-bedrock', model: 'model-a' }),
          runOmpRegistryOperation: () => {
            called = true;
          },
        }
      )
    ).to.throw('AWS_BEARER_TOKEN_BEDROCK');
    expect(called).to.equal(false);
  });

  it('requires registry auth evidence for none mode and accepts a configured keyless model', () => {
    const settings = { providerSettings: { omp: ompSettings({ mode: 'none' }) } };
    const deps = {
      env: {},
      loadSettings: () => settings,
      resolveOmpSdkSettings: (stored) => stored.providerSettings.omp,
      parseExactOmpModelSelector: () => ({ provider: 'local', model: 'model-a' }),
    };
    expect(() =>
      doctorCommand(
        'local/model-a',
        {},
        {
          ...deps,
          runOmpRegistryOperation: () => ({
            resolvedSelector: 'local/model-a',
            authConfigured: false,
            route: { api: 'openai-completions', origin: 'http://127.0.0.1:11434' },
            probe: null,
          }),
        }
      )
    ).to.throw('auth is not configured for provider local');

    const healthy = captureLogs(() =>
      doctorCommand(
        'local/model-a',
        {},
        {
          ...deps,
          runOmpRegistryOperation: () => ({
            resolvedSelector: 'local/model-a',
            authConfigured: true,
            route: { api: 'openai-completions', origin: 'http://127.0.0.1:11434' },
            probe: null,
          }),
        }
      )
    );
    expect(healthy.output).to.include('Credential configuration: configured');
  });

  it('rejects empty broker credentials before registry access', () => {
    let called = false;
    expect(() =>
      doctorCommand(
        'amazon-bedrock/model-a',
        {},
        {
          env: { OMP_AUTH_BROKER_URL: '', OMP_AUTH_BROKER_TOKEN: '' },
          loadSettings: () => ({
            providerSettings: { omp: ompSettings({ mode: 'broker' }) },
          }),
          resolveOmpSdkSettings: (stored) => stored.providerSettings.omp,
          parseExactOmpModelSelector: () => ({
            provider: 'amazon-bedrock',
            model: 'model-a',
          }),
          runOmpRegistryOperation: () => {
            called = true;
          },
        }
      )
    ).to.throw('OMP_AUTH_BROKER');
    expect(called).to.equal(false);
  });

  it('exposes only read-only provider commands', () => {
    expect(Object.keys(providerCommands).sort()).to.deep.equal([
      'credentialEvidence',
      'doctorCommand',
      'listCommand',
      'manualConfiguration',
      'providersCommand',
      'runOmpRegistryOperation',
      'validateCommand',
    ]);

    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'cli', 'index.js'), 'providers', '--help'],
      { encoding: 'utf8' }
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.include('list');
    expect(result.stdout).to.include('validate');
    expect(result.stdout).to.include('doctor');
    expect(result.stdout).not.to.match(/\b(?:import-omp|set-default|setup|login|apply)\b/);
  });

  it('rejects provider and generic settings mutations without prompting or changing settings', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-provider-readonly-'));
    fs.chmodSync(directory, 0o700);
    const settingsFile = path.join(directory, 'settings.json');
    const original = '{"defaultProvider":"claude","sentinel":"unchanged"}\n';
    fs.writeFileSync(settingsFile, original, { mode: 0o600 });
    const cli = path.join(__dirname, '..', 'cli', 'index.js');

    try {
      for (const args of [
        ['providers', 'import-omp', '--from', '/tmp/models.yml'],
        ['providers', 'set-default', 'omp'],
        ['providers', 'setup', 'omp'],
        ['settings', 'set', 'defaultProvider', 'omp'],
        ['settings', 'set', 'providerSettings.omp.transport', '"rpc"'],
        ['settings', 'set', 'maxModel', 'haiku'],
        ['settings', 'set', 'minModel', 'haiku'],
      ]) {
        const result = spawnSync(process.execPath, [cli, ...args], {
          encoding: 'utf8',
          env: { ...process.env, ZEROSHOT_SETTINGS_FILE: settingsFile },
          input: '',
          timeout: 2_000,
        });
        expect(result.error).to.equal(undefined);
        expect(result.status).not.to.equal(0);
        expect(result.stderr).not.to.equal('');
        expect(fs.readFileSync(settingsFile, 'utf8')).to.equal(original);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('settings reset preserves manually managed provider configuration', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-provider-reset-'));
    fs.chmodSync(directory, 0o700);
    const settingsFile = path.join(directory, 'settings.json');
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        defaultProvider: 'codex',
        providerSettings: { codex: { webSearch: true } },
        logLevel: 'verbose',
        maxModel: 'haiku',
        minModel: 'haiku',
      }),
      { mode: 0o600 }
    );

    try {
      const result = spawnSync(
        process.execPath,
        [path.join(__dirname, '..', 'cli', 'index.js'), 'settings', 'reset', '--yes'],
        {
          encoding: 'utf8',
          env: { ...process.env, ZEROSHOT_SETTINGS_FILE: settingsFile },
          input: '',
          timeout: 2_000,
        }
      );
      expect(result.error).to.equal(undefined);
      expect(result.status).to.equal(0);
      const reset = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      expect(reset.defaultProvider).to.equal('codex');
      expect(reset.maxModel).to.equal('haiku');
      expect(reset.minModel).to.equal('haiku');
      expect(reset.providerSettings.codex.webSearch).to.equal(true);
      expect(reset.logLevel).to.equal('normal');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports the canonical manual configuration and local auth source', () => {
    const manual = manualConfiguration(
      { providerSettings: { omp: ompSettings() } },
      { getSettingsFile: () => '/private/zeroshot/settings.json' }
    );

    expect(manual).to.deep.equal({
      settingsFile: '/private/zeroshot/settings.json',
      settingsField: 'providerSettings.omp',
      authSource: 'environment variables: AWS_BEARER_TOKEN_BEDROCK',
      fileMode: '0600',
      directoryMode: '0700',
      reload:
        'Rerun the command or start a new run to reload settings; restart already-running or detached work.',
    });
  });

  it('directs validation failures to manual configuration without exposing secrets', () => {
    const secret = 'must-not-be-disclosed';
    let failure;
    try {
      validateCommand(
        {},
        {
          env: { AWS_BEARER_TOKEN_BEDROCK: secret },
          getSettingsFile: () => '/private/zeroshot/settings.json',
          loadSettings: () => ({ providerSettings: { omp: ompSettings() } }),
          resolveOmpSdkSettings: () => {
            throw new Error('OMP settings are incomplete');
          },
          runOmpRegistryOperation: () => {
            throw new Error('registry must not run');
          },
        }
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.an('error');
    expect(failure.message).to.match(
      /providerSettings\.omp in \/private\/zeroshot\/settings\.json/
    );
    expect(failure.message).to.include('0600');
    expect(failure.message).to.include('0700');
    expect(failure.message).to.include('restart');
    expect(failure.message).not.to.include(secret);
  });

  it('preserves the original validation error when omp-home path formatting is malformed', () => {
    let failure;
    try {
      validateCommand(
        {},
        {
          env: {},
          getSettingsFile: () => '/private/zeroshot/settings.json',
          loadSettings: () => ({
            providerSettings: {
              omp: ompSettings({ mode: 'omp-home', path: { malformed: true } }),
            },
          }),
          resolveOmpSdkSettings: () => {
            throw new Error('original omp-home validation failure');
          },
        }
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.an('error');
    expect(failure.message).to.include('original omp-home validation failure');
    expect(failure.message).to.include('providerSettings.omp in /private/zeroshot/settings.json');
    expect(failure.message).to.include('providerSettings.omp.auth.path (invalid local host path)');
  });

  it('passes only the omp-home database source to the shared private auth policy', () => {
    const localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-provider-auth-source-'));
    fs.chmodSync(localHome, 0o700);
    const source = path.join(localHome, 'agent.db');
    const original = Buffer.from('local-auth-database-fixture');
    fs.writeFileSync(source, original, { mode: 0o600 });

    try {
      runOmpRegistryOperation(
        'validate',
        ompSettings({ mode: 'omp-home', path: localHome }),
        {},
        {
          compilePrivateOmpModelsYaml: () => '{"providers":{}}\n',
          env: {},
          resolveOmpSdkRuntime: () => ({
            bunExecutable: '/private/bun',
            bunVersion: '1.3.14',
            ompEntryPath: '/private/omp.ts',
            ompVersion: '17.2.1',
          }),
          spawnSync: (_command, _args, options) => {
            const request = JSON.parse(
              fs.readFileSync(options.env.ZEROSHOT_OMP_PROVIDER_REQUEST, 'utf8')
            );
            expect(request.auth.sourcePath).to.equal(localHome);
            expect(request.authDbPath).not.to.equal(source);
            expect(fs.existsSync(request.authDbPath)).to.equal(false);
            expect(path.basename(request.authPolicyPath)).to.equal('omp-auth-policy.ts');
            return {
              status: 0,
              stdout:
                'ZEROSHOT_OMP_PROVIDER_RESULT {"ok":true,"result":{"modelCount":1,"selectors":["local/model"]}}\n',
            };
          },
        }
      );

      expect(fs.readFileSync(source)).to.deep.equal(original);
      expect(fs.statSync(source).mode & 0o777).to.equal(0o600);
    } finally {
      fs.rmSync(localHome, { recursive: true, force: true });
    }
  });
});
