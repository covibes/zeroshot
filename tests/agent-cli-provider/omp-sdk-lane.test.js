const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { withFakeProviderCli, withTempEnv } = require('./executable-contract-helpers.cjs');

const helper = require('../../lib/agent-cli-provider');
const MODEL = 'amazon-bedrock/openai.gpt-5.6-sol';
const CREDENTIAL_NAME = 'AWS_BEARER_TOKEN_BEDROCK';
const SECRET = 'sdk-lane-secret-never-persist';
const PROMPT = 'sdk lane private prompt never enters command metadata';
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

function sdkSettings(overrides = {}) {
  const level = { model: MODEL, reasoningEffort: 'max' };
  return {
    defaultProvider: 'omp',
    providerSettings: {
      omp: {
        minLevel: 'level1',
        defaultLevel: 'level2',
        maxLevel: 'level3',
        levelOverrides: { level1: level, level2: level, level3: level },
        modelsConfig: { providers: {} },
        auth: {
          mode: 'environment',
          credentials: { 'amazon-bedrock': { env: CREDENTIAL_NAME } },
        },
        tools: ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'lsp', 'ast_edit'],
        nestedAgents: false,
        mcp: false,
        ...overrides,
      },
    },
  };
}

function withSettings(settings, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-lane-settings-'));
  const settingsPath = path.join(root, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  try {
    return withTempEnv(
      { ZEROSHOT_SETTINGS_FILE: settingsPath, [CREDENTIAL_NAME]: SECRET },
      callback
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function removePreparedRoot(prepared) {
  if (prepared?.privateArtifacts?.root) {
    fs.rmSync(prepared.privateArtifacts.root, { recursive: true, force: true });
  }
}

test('OMP omitted transport selects the SDK sidecar without probing a global omp CLI', () => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-probe-marker-'));
  const marker = path.join(probeRoot, 'global-omp-ran');
  let prepared;
  let probe;
  try {
    withFakeProviderCli(
      'omp',
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.exit(91);\n`,
      () =>
        withSettings(sdkSettings(), () => {
          probe = helper.probeRuntimeProviderCli('omp');
          prepared = helper.prepareSingleAgentProviderCommand({
            provider: 'omp',
            context: PROMPT,
            options: {
              cwd: process.cwd(),
              executionContext: 'host',
              outputFormat: 'json',
              jsonSchema: SCHEMA,
              strictSchema: true,
              modelSpec: { level: 'level2', model: MODEL, reasoningEffort: 'max' },
            },
          });
        })
    );

    assert.equal(fs.existsSync(marker), false);
    assert.equal(probe.available, true);
    assert.equal(probe.helpText, 'Pinned bundled OMP SDK sidecar');
    assert.match(probe.versionText, /^omp-sdk 17\.2\.1; bun 1\.3\.14$/);
    assert.deepEqual(prepared.invoke, {
      lane: 'spawn',
      parser: 'omp-sdk-ndjson',
      ptyEligible: false,
      strictTerminal: true,
    });
    assert.deepEqual(prepared.environmentPolicy, { inherit: 'minimal', values: {} });
    assert.deepEqual(prepared.credentialNames, [CREDENTIAL_NAME]);
    assert.deepEqual(prepared.executionIdentity, {
      backend: 'omp-sdk',
      backendVersion: '17.2.1',
      runtime: { name: 'bun', version: '1.3.14' },
      transport: 'sdk',
    });
    assert.deepEqual(prepared.semanticIdentity, {
      requestedModelSelector: MODEL,
      reasoningEffort: 'max',
      provider: 'amazon-bedrock',
    });
    assert.deepEqual(prepared.containmentRequirement, {
      mode: 'host-process-tree',
      required: true,
    });
    assert.equal(prepared.commandSpec.invocation.pty, false);
    assert.equal(prepared.commandSpec.args.length, 2);
    assert.equal(prepared.commandSpec.args[1], prepared.privateArtifacts.requestPath);
    assert.equal(path.basename(prepared.commandSpec.args[0]), 'omp-sdk-sidecar.ts');
    assert.deepEqual(prepared.commandSpec.env, {});
    assert.deepEqual(prepared.commandSpec.cleanup, [prepared.privateArtifacts.root]);
    assert.deepEqual(prepared.commandSpec.cleanupMetadata, [
      {
        kind: 'temp-directory',
        provider: 'omp',
        path: prepared.privateArtifacts.root,
        reason: 'sdk-private-root',
      },
    ]);
    assert.equal(Object.hasOwn(prepared.options, 'authEnv'), false);
    assert.equal(JSON.stringify(prepared.commandSpec).includes(PROMPT), false);
    assert.equal(JSON.stringify(prepared).includes(SECRET), false);

    const rootMode = fs.statSync(prepared.privateArtifacts.root).mode & 0o777;
    const requestMode = fs.statSync(prepared.privateArtifacts.requestPath).mode & 0o777;
    assert.equal(rootMode, 0o700);
    assert.equal(requestMode, 0o600);
    const request = JSON.parse(fs.readFileSync(prepared.privateArtifacts.requestPath, 'utf8'));
    assert.equal(request.prompt, PROMPT);
    assert.deepEqual(fs.readdirSync(prepared.privateArtifacts.root), ['request.json']);
    assert.equal(request.context, '');
    assert.equal(request.executionContext, 'host');
    assert.deepEqual(request.auth, {
      mode: 'environment',
      credentials: { 'amazon-bedrock': { env: CREDENTIAL_NAME } },
    });
    assert.equal(request.modelSelector, MODEL);
    assert.equal(request.outputMode, 'json');
    assert.deepEqual(request.outputSchema, SCHEMA);
    assert.equal(JSON.stringify(request).includes(SECRET), false);
  } finally {
    removePreparedRoot(prepared);
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('OMP SDK text preparation carries the host envelope lane and container containment', () => {
  let prepared;
  try {
    withSettings(sdkSettings(), () => {
      prepared = helper.prepareSingleAgentProviderCommand({
        provider: 'omp',
        context: PROMPT,
        options: {
          cwd: process.cwd(),
          executionContext: 'docker',
          outputFormat: 'text',
          modelSpec: { level: 'level1' },
        },
      });
    });
    const request = JSON.parse(fs.readFileSync(prepared.privateArtifacts.requestPath, 'utf8'));
    assert.equal(request.outputMode, 'text');
    assert.deepEqual(
      helper.ompSdkOutputSchemaForRequest(helper.parseOmpSdkSidecarRequest(request)),
      helper.OMP_SDK_TEXT_OUTPUT_SCHEMA
    );
    assert.equal(Object.hasOwn(request, 'outputSchema'), false);
    assert.deepEqual(prepared.containmentRequirement, { mode: 'container', required: true });
    assert.equal(prepared.commandSpec.binary, '/opt/zeroshot/node_modules/bun/bin/bun.exe');
    assert.equal(prepared.commandSpec.args[0], '/opt/zeroshot/scripts/omp-sdk-sidecar.ts');
    assert.equal(prepared.options.strictSchema, true);
  } finally {
    removePreparedRoot(prepared);
  }
});

test('OMP SDK rejects missing execution context, resume, continue, and prompt-only schemas', () => {
  withSettings(sdkSettings(), () => {
    const base = {
      provider: 'omp',
      context: PROMPT,
      options: { cwd: process.cwd(), outputFormat: 'text' },
    };
    assert.throws(
      () => helper.prepareSingleAgentProviderCommand(base),
      /executionContext is required/i
    );
    assert.throws(
      () =>
        helper.prepareSingleAgentProviderCommand({
          ...base,
          options: { ...base.options, executionContext: 'host', resumeSessionId: 'old-session' },
        }),
      /always fresh/i
    );
    assert.throws(
      () =>
        helper.prepareSingleAgentProviderCommand({
          ...base,
          options: { ...base.options, executionContext: 'host', continueSession: true },
        }),
      /always fresh/i
    );
    assert.throws(
      () =>
        helper.prepareSingleAgentProviderCommand({
          ...base,
          options: {
            ...base.options,
            executionContext: 'host',
            outputFormat: 'json',
            jsonSchema: SCHEMA,
            strictSchema: false,
          },
        }),
      /strict schema enforcement/i
    );
  });
});

test('prepared direct invocation preserves Claude strict-schema non-PTY selection', () => {
  withSettings({}, () => {
    const cliFeatures = {
      supportsOutputFormat: true,
      supportsJsonSchema: true,
      supportsAutoApprove: true,
      supportsModel: true,
      supportsEffort: true,
    };
    const strict = helper.prepareSingleAgentProviderCommand({
      provider: 'claude',
      context: 'strict direct prompt',
      options: {
        cwd: process.cwd(),
        outputFormat: 'json',
        jsonSchema: SCHEMA,
        cliFeatures,
      },
    });
    const plain = helper.prepareSingleAgentProviderCommand({
      provider: 'claude',
      context: 'plain direct prompt',
      options: {
        cwd: process.cwd(),
        outputFormat: 'text',
        cliFeatures,
      },
    });

    assert.equal(strict.invoke.ptyEligible, false);
    assert.equal(plain.invoke.ptyEligible, true);
  });
});

test('OMP omitted transport requires semantic configuration without probing a global omp CLI', () => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-default-probe-'));
  const marker = path.join(probeRoot, 'global-omp-ran');
  try {
    withFakeProviderCli(
      'omp',
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.exit(91);\n`,
      () =>
        withSettings({ defaultProvider: 'omp' }, () => {
          assert.throws(
            () =>
              helper.prepareSingleAgentProviderCommand({
                context: 'SDK default requires a semantic model',
                options: {
                  cwd: process.cwd(),
                  executionContext: 'host',
                  outputFormat: 'text',
                },
              }),
            /explicit full provider\/model selectors for every level/i
          );
          const probe = helper.probeRuntimeProviderCli('omp');
          assert.equal(probe.available, false);
          assert.equal(probe.helpText, '');
          assert.equal(probe.versionText, '');
        })
    );
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('explicit OMP RPC transport fails instead of borrowing SDK or legacy CLI semantics', () => {
  assert.equal(helper.getProviderRegistryEntry('omp').capabilities.jsonSchema, false);
  withSettings(
    {
      defaultProvider: 'omp',
      providerSettings: { omp: { transport: 'rpc' } },
    },
    () => {
      assert.throws(
        () =>
          helper.prepareSingleAgentProviderCommand({
            provider: 'omp',
            context: PROMPT,
            options: { cwd: process.cwd(), outputFormat: 'text' },
          }),
        /RPC transport is not implemented.*cannot borrow SDK strict-output semantics.*legacy `omp --mode json`/i
      );
    }
  );
});
