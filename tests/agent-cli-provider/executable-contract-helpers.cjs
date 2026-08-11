const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const repoRoot = path.resolve(__dirname, '..', '..');
const executablePath = path.join(repoRoot, 'lib', 'agent-cli-provider', 'executable.js');

function runExecutable(input) {
  const child = spawnSync(process.execPath, [executablePath], {
    cwd: repoRoot,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
  const stdout = child.stdout.trim();
  return {
    exitCode: child.status,
    stderr: child.stderr,
    stdout,
    envelope: stdout ? JSON.parse(stdout) : null,
  };
}

function assertNoSecret(value, secret) {
  const assert = require('node:assert/strict');
  assert.equal(JSON.stringify(value).includes(secret), false);
}

function runProviderExecutable(input, options) {
  const helper = require('../../lib/agent-cli-provider');
  return helper.runProviderExecutable(
    typeof input === 'string' ? input : JSON.stringify(input),
    options
  );
}

function runnerResult(overrides = {}) {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 1,
    ...overrides,
  };
}

function codexSchemaOptions(overrides = {}) {
  return {
    outputFormat: 'json',
    jsonSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
      },
    },
    cliFeatures: {
      supportsJson: true,
      supportsOutputSchema: true,
      supportsSkipGitRepoCheck: true,
      ...(overrides.cliFeatures || {}),
    },
    ...overrides,
  };
}

function withTempEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withOmpRpcSettings(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-rpc-settings-'));
  const settingsFile = path.join(tempDir, 'settings.json');
  const previousSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;

  try {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ providerSettings: { omp: { transport: 'rpc' } } }),
      { mode: 0o600 }
    );
    process.env.ZEROSHOT_SETTINGS_FILE = settingsFile;
    return await fn();
  } finally {
    if (previousSettingsFile === undefined) {
      delete process.env.ZEROSHOT_SETTINGS_FILE;
    } else {
      process.env.ZEROSHOT_SETTINGS_FILE = previousSettingsFile;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function withFakeProviderCli(provider, script, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-provider-cli-'));
  writeExecutable(path.join(tempDir, provider), script);

  try {
    return withTempEnv({ PATH: `${tempDir}${path.delimiter}${process.env.PATH || ''}` }, fn);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function fakeCodexScript(body) {
  return `#!/usr/bin/env node\n${body}\n`;
}

function fakePiScript(body) {
  return `#!/usr/bin/env node\n${body}\n`;
}

function withCurrentPiCli(fn) {
  return withFakeProviderCli(
    'pi',
    fakePiScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: pi --mode json --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model --thinking\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('0.84.1\\n');
  process.exit(0);
}
process.exit(0);
`),
    fn
  );
}

function withKiroWithoutAcp(fn) {
  return withFakeProviderCli(
    'kiro-cli',
    fakeKiroScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: kiro-cli --version\\n');
  process.exit(0);
}
process.stderr.write('kiro-cli acp should not execute');
process.exit(17);
`),
    fn
  );
}

function assertUnsupportedAcpResponse(response) {
  const assert = require('node:assert/strict');
  assert.equal(response.exitCode, 2);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.error.code, 'invalid-field');
  assert.equal(response.envelope.error.field, 'options.cliFeatures.supportsAcpStdio');
  assert.match(response.envelope.error.message, /does not advertise ACP stdio support/i);
}

function fakeKiroScript(body) {
  return `#!/usr/bin/env node\n${body}\n`;
}

function fakeCopilotScript(body) {
  return `#!/usr/bin/env node\n${body}\n`;
}

function fakeOmpScript(body) {
  return `#!/usr/bin/env node\n${body}\n`;
}

function invokeCodexSchemaRequest(overrides = {}) {
  return {
    schemaVersion: 1,
    command: 'invoke',
    provider: 'codex',
    context: 'Return JSON.',
    ...overrides,
    options: codexSchemaOptions(overrides.options || {}),
  };
}

module.exports = {
  assertNoSecret,
  assertUnsupportedAcpResponse,
  codexSchemaOptions,
  invokeCodexSchemaRequest,
  fakeCodexScript,
  fakeCopilotScript,
  fakeKiroScript,
  fakeOmpScript,
  fakePiScript,
  repoRoot,
  runExecutable,
  runProviderExecutable,
  runnerResult,
  withFakeProviderCli,
  withCurrentPiCli,
  withKiroWithoutAcp,
  withTempEnv,
  withOmpRpcSettings,
};
