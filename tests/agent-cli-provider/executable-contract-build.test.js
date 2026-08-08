const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertNoSecret,
  fakeCodexScript,
  fakeCopilotScript,
  fakeKiroScript,
  fakePiScript,
  runExecutable,
  withFakeProviderCli,
  withTempEnv,
  withOmpRpcSettings,
} = require('./executable-contract-helpers.cjs');

test('build-command returns command spec without executing provider CLI', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'codex',
    context: 'Return JSON.',
    options: {
      outputFormat: 'json',
      cwd: '/tmp/project',
      cliFeatures: {
        supportsJson: true,
        supportsCwd: true,
        supportsSkipGitRepoCheck: true,
      },
    },
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.stderr, '');
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.schemaVersion, 1);
  assert.equal(response.envelope.command, 'build-command');
  assert.equal(response.envelope.provider, 'codex');
  assert.equal(typeof response.envelope.adapterVersion, 'string');
  assert.equal(response.envelope.result.commandSpec.binary, 'codex');
  assert.equal(response.envelope.result.commandSpec.cwd, '/tmp/project');
  assert.ok(Array.isArray(response.envelope.result.commandSpec.args));
  assert.equal(typeof response.envelope.result.commandSpec.env, 'object');
  assert.ok(Array.isArray(response.envelope.warnings));
  assert.ok(Array.isArray(response.envelope.redactions));
});

test('build-command selects the Codex sandbox from the declared execution boundary', () => {
  for (const { executionContext, sandboxMode } of [
    { executionContext: undefined, sandboxMode: 'workspace-write' },
    { executionContext: 'host', sandboxMode: 'workspace-write' },
    { executionContext: 'detached', sandboxMode: 'workspace-write' },
    { executionContext: 'docker', sandboxMode: 'danger-full-access' },
    { executionContext: 'benchmark', sandboxMode: 'danger-full-access' },
  ]) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'build-command',
      provider: 'codex',
      context: 'Edit the workspace.',
      options: {
        autoApprove: true,
        ...(executionContext === undefined ? {} : { executionContext }),
        cliFeatures: {
          supportsAutoApprove: true,
          supportsConfigOverride: true,
          supportsSandbox: true,
        },
      },
    });

    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    const { args } = response.envelope.result.commandSpec;
    assert.ok(args.includes('--sandbox'));
    assert.ok(args.includes(sandboxMode));
    assert.ok(args.includes('approval_policy="never"'));
    assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  }
});

test('partial CLI feature overrides do not probe or drift when web search is off', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-no-search-probe-'));
  const settingsFile = path.join(tempDir, 'settings.json');
  fs.writeFileSync(settingsFile, '{}');

  try {
    for (const provider of ['codex', 'opencode']) {
      const marker = path.join(tempDir, `${provider}-probed`);
      const script = `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'probed');
process.exit(0);
`;
      withFakeProviderCli(provider, script, () =>
        withTempEnv({ ZEROSHOT_SETTINGS_FILE: settingsFile }, () => {
          const cliFeatures =
            provider === 'codex'
              ? { supportsJson: true, supportsSkipGitRepoCheck: true }
              : { supportsJson: true };
          const baseRequest = {
            schemaVersion: 1,
            command: 'build-command',
            provider,
            context: 'ctx',
          };
          const absent = runExecutable({
            ...baseRequest,
            options: { outputFormat: 'json', cliFeatures },
          });
          const disabled = runExecutable({
            ...baseRequest,
            options: { outputFormat: 'json', webSearch: false, cliFeatures },
          });

          assert.equal(absent.exitCode, 0);
          assert.equal(disabled.exitCode, 0);
          assert.deepEqual(
            disabled.envelope.result.commandSpec.args,
            absent.envelope.result.commandSpec.args
          );
          assert.deepEqual(
            disabled.envelope.result.commandSpec.env,
            absent.envelope.result.commandSpec.env
          );
          assert.equal(fs.existsSync(marker), false);
        })
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('build-command preserves Claude resume and continue options through JSON contract', () => {
  const resumed = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'claude',
    context: 'ctx',
    options: {
      resumeSessionId: 'sess-1',
    },
  });

  assert.equal(resumed.exitCode, 0);
  assert.equal(resumed.envelope.ok, true);
  assert.deepEqual(resumed.envelope.result.commandSpec.args.slice(-3), [
    '--resume',
    'sess-1',
    'ctx',
  ]);

  const continued = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'claude',
    context: 'ctx',
    options: {
      continueSession: true,
    },
  });

  assert.equal(continued.exitCode, 0);
  assert.equal(continued.envelope.ok, true);
  assert.deepEqual(continued.envelope.result.commandSpec.args.slice(-2), ['--continue', 'ctx']);
});

test('build-command preserves Codex explicit session resume through JSON contract', () => {
  const resumed = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'codex',
    context: 'ctx',
    options: {
      resumeSessionId: 'thread-1',
      cwd: '/tmp/project',
      cliFeatures: {
        supportsResume: true,
        supportsCwd: true,
      },
    },
  });

  assert.equal(resumed.exitCode, 0);
  assert.equal(resumed.envelope.ok, true);
  assert.deepEqual(resumed.envelope.result.commandSpec.args.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(resumed.envelope.result.commandSpec.args.slice(-2), ['thread-1', 'ctx']);
  assert.equal(resumed.envelope.result.commandSpec.args.includes('-C'), false);
  assert.equal(resumed.envelope.result.commandSpec.cwd, '/tmp/project');
});

test('build-command emits the omp-jsonschema warning through the executable envelope', () =>
  withOmpRpcSettings(() => {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'build-command',
      provider: 'omp',
      context: 'ctx',
      options: {
        modelSpec: { level: 'level3', model: 'm', reasoningEffort: 'high' },
        jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        cliFeatures: {
          versionMatches: true,
          supportsRpcMode: true,
          supportsConfig: true,
          supportsModel: true,
          supportsThinking: true,
          supportsApprovalMode: true,
          supportsNoTitle: true,
          supportsNoSession: true,
          supportsSessionDir: false,
          supportsResume: false,
        },
      },
    });

    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    const { args } = response.envelope.result.commandSpec;
    assert.deepEqual(args.slice(0, 6), [
      '--mode',
      'rpc',
      '--no-session',
      '--model',
      'm',
      '--thinking',
    ]);
    assert.equal(args[6], 'high');
    assert.deepEqual(args.slice(7), [
      '--approval-mode',
      'yolo',
      '--no-title',
      '--config',
      args.at(-1),
    ]);
    assert.deepEqual(
      response.envelope.warnings.map(({ code }) => code),
      ['omp-jsonschema']
    );
    const overlayDir = path.dirname(args.at(-1));
    fs.rmSync(overlayDir, { recursive: true, force: true });
  }));

test('build-command refuses to export an OMP invocation when transport defaults to SDK', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-sdk-build-contract-'));
  const settingsFile = path.join(tempDir, 'settings.json');
  const credentialName = 'AWS_BEARER_TOKEN_BEDROCK';
  const secret = 'sdk-build-command-secret';
  const model = 'amazon-bedrock/openai.gpt-5.6-luna';
  const level = { model, reasoningEffort: 'max' };
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      providerSettings: {
        omp: {
          minLevel: 'level1',
          defaultLevel: 'level2',
          maxLevel: 'level3',
          levelOverrides: { level1: level, level2: level, level3: level },
          modelsConfig: { providers: {} },
          auth: {
            mode: 'environment',
            credentials: { 'amazon-bedrock': { env: credentialName } },
          },
          tools: ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'lsp', 'ast_edit'],
          nestedAgents: false,
          mcp: false,
        },
      },
    }),
    { mode: 0o600 }
  );

  try {
    const response = withTempEnv(
      {
        ZEROSHOT_SETTINGS_FILE: settingsFile,
        TMPDIR: tempDir,
        [credentialName]: secret,
      },
      () =>
        runExecutable({
          schemaVersion: 1,
          command: 'build-command',
          provider: 'omp',
          context: 'private SDK prompt',
          options: {
            cwd: process.cwd(),
            executionContext: 'host',
            outputFormat: 'json',
            jsonSchema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
              additionalProperties: false,
            },
            strictSchema: true,
            modelSpec: { level: 'level2', model, reasoningEffort: 'max' },
          },
        })
    );

    assert.equal(response.exitCode, 4);
    assert.equal(response.envelope.ok, false);
    assert.equal(response.envelope.error.code, 'unsupported-capability');
    assert.match(response.envelope.error.message, /build-command.*use invoke instead/i);
    assert.equal(Object.hasOwn(response.envelope, 'result'), false);
    assert.equal(JSON.stringify(response.envelope).includes('commandSpec'), false);
    assert.equal(JSON.stringify(response.envelope).includes('omp-sdk-sidecar'), false);
    assertNoSecret(response.envelope, secret);
    assert.deepEqual(fs.readdirSync(tempDir), ['settings.json']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('build-command redacts adapter auth env values from command spec output', () => {
  const secret = 'plain-secret';
  const response = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'claude',
    context: 'Return JSON.',
    options: {
      authEnv: {
        CUSTOM: secret,
      },
    },
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.commandSpec.env.CUSTOM.includes(secret), false);
  assertNoSecret(response.envelope, secret);
});

test('build-command preserves metadata when benign env values match contract fields', () => {
  for (const { env, context, expectedProvider, expectedBinary, expectedAdapterVersion } of [
    {
      env: { FOO: 'codex' },
      context: 'codex',
      expectedProvider: 'codex',
      expectedBinary: 'codex',
      expectedAdapterVersion: '1',
    },
    {
      env: { FOO: '1' },
      context: '1',
      expectedProvider: 'codex',
      expectedBinary: 'codex',
      expectedAdapterVersion: '1',
    },
  ]) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'build-command',
      provider: 'codex',
      context,
      env,
    });

    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    assert.equal(response.envelope.provider, expectedProvider);
    assert.equal(response.envelope.adapterVersion, expectedAdapterVersion);
    assert.equal(response.envelope.result.commandSpec.binary, expectedBinary);
    assert.equal(response.envelope.result.commandSpec.args.at(-1), context);
    assert.equal(response.envelope.result.commandSpec.env.FOO, '[REDACTED:FOO]');
    assert.deepEqual(response.envelope.redactions, [{ kind: 'env', key: 'FOO' }]);
  }
});

test('build-command preserves stable evidence when benign env values match schema metadata', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'codex',
    context: 'Return JSON.',
    env: {
      FORMAT: 'json',
      MODE: 'none',
    },
    options: {
      outputFormat: 'json',
    },
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.evidence.outputFormat, 'json');
  assert.equal(response.envelope.evidence.schemaMode, 'none');
  assert.equal(response.envelope.result.outputFormat, 'json');
  assert.equal(response.envelope.result.schemaMode, 'none');
});

test('build-command probes local Codex CLI features without caller-supplied cliFeatures', () => {
  withFakeProviderCli(
    'codex',
    fakeCodexScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: codex exec --json --skip-git-repo-check -m --config --cwd -C\\n');
  process.exit(0);
}
process.stdout.write('unexpected execution');
process.exit(17);
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'build-command',
        provider: 'codex',
        context: 'Return JSON.',
        options: {
          outputFormat: 'json',
        },
      });

      assert.equal(response.exitCode, 0);
      assert.equal(response.envelope.ok, true);
      assert.ok(response.envelope.result.commandSpec.args.includes('--json'));
    }
  );
});

test('build-command returns ACP stdio command specs without prompt argv coupling', () => {
  withFakeProviderCli(
    'kiro-cli',
    fakeKiroScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: kiro-cli acp\\n');
  process.exit(0);
}
process.stderr.write('build-command should not execute kiro-cli acp');
process.exit(17);
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'build-command',
        provider: 'kiro',
        context: 'Reply with OK',
        options: {
          cwd: '/tmp/kiro-worktree',
        },
      });

      assert.equal(response.exitCode, 0);
      assert.equal(response.envelope.ok, true);
      assert.equal(response.envelope.result.commandSpec.binary, 'kiro-cli');
      assert.deepEqual(response.envelope.result.commandSpec.args, ['acp']);
      assert.equal(response.envelope.result.commandSpec.cwd, '/tmp/kiro-worktree');
      assert.equal(response.envelope.result.commandSpec.args.includes('Reply with OK'), false);
    }
  );
});

test('build-command returns bundled gateway runner specs with redacted config env', () => {
  const secret = 'gateway-secret-token';
  const response = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'gateway',
    context: 'Edit the target file.',
    options: {
      cwd: '/tmp/gateway-project',
      gateway: {
        baseUrl: 'http://127.0.0.1:4000',
        apiKey: secret,
        headers: {
          'X-API-Key': 'custom-header-secret-42',
        },
        model: 'openrouter/test-model',
        toolPolicy: {
          roots: ['.'],
          commands: ['node'],
        },
      },
    },
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.provider, 'gateway');
  assert.equal(response.envelope.result.commandSpec.binary, process.execPath);
  assert.match(response.envelope.result.commandSpec.args[0], /gateway-runner\.js$/);
  assert.equal(
    response.envelope.result.commandSpec.env.ZEROSHOT_GATEWAY_REQUEST.includes(secret),
    false
  );
  assert.equal(
    response.envelope.result.commandSpec.env.ZEROSHOT_GATEWAY_REQUEST.includes(
      'custom-header-secret-42'
    ),
    false
  );
  assertNoSecret(response.envelope, secret);
  assertNoSecret(response.envelope, 'custom-header-secret-42');
});

test('build-command rejects caller env that collides with gateway runner control vars', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'gateway',
    context: 'Edit the target file.',
    env: {
      ZEROSHOT_GATEWAY_API_KEY: 'attacker-key',
    },
    options: {
      gateway: {
        baseUrl: 'http://127.0.0.1:4000',
        apiKey: 'gateway-secret-token',
        model: 'openrouter/test-model',
        toolPolicy: {
          roots: ['.'],
          commands: ['node'],
        },
      },
    },
  });

  assert.equal(response.exitCode, 2);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.error.code, 'forbidden-field');
  assert.equal(response.envelope.error.field, 'env.ZEROSHOT_GATEWAY_API_KEY');
  assert.match(response.envelope.error.message, /provider adapters own ZEROSHOT_GATEWAY_API_KEY/i);
});

test('build-command resolves gateway settings tool roots against options.cwd', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-settings-'));
  const settingsFile = path.join(tempDir, 'settings.json');
  const worktree = path.join(tempDir, 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        providerSettings: {
          gateway: {
            baseUrl: 'http://127.0.0.1:4000',
            apiKey: 'gateway-secret-token',
            model: 'openrouter/test-model',
            toolPolicy: {
              roots: ['.'],
              commands: ['node'],
            },
          },
        },
      },
      null,
      2
    ),
    'utf8'
  );

  try {
    withTempEnv({ ZEROSHOT_SETTINGS_FILE: settingsFile }, () => {
      const prepared = require('../../lib/agent-cli-provider').prepareSingleAgentProviderCommand({
        context: 'Edit the target file.',
        provider: 'gateway',
        options: {
          cwd: worktree,
        },
      });

      const request = JSON.parse(prepared.commandSpec.env.ZEROSHOT_GATEWAY_REQUEST);
      assert.deepEqual(request.gateway.toolPolicy.roots, [worktree]);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('build-command fails closed when ACP stdio support is not advertised', () => {
  withFakeProviderCli(
    'kiro-cli',
    fakeKiroScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: kiro-cli --version\\n');
  process.exit(0);
}
process.stderr.write('build-command should not execute kiro-cli acp');
process.exit(17);
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'build-command',
        provider: 'kiro',
        context: 'Reply with OK',
      });

      assert.equal(response.exitCode, 2);
      assert.equal(response.envelope.ok, false);
      assert.equal(response.envelope.error.code, 'invalid-field');
      assert.equal(response.envelope.error.field, 'options.cliFeatures.supportsAcpStdio');
      assert.match(response.envelope.error.message, /does not advertise ACP stdio support/i);
    }
  );
});

test('build-command ignores caller ACP support overrides when runtime probe rejects ACP stdio', () => {
  withFakeProviderCli(
    'kiro-cli',
    fakeKiroScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: kiro-cli --version\\n');
  process.exit(0);
}
process.stderr.write('build-command should not execute kiro-cli acp');
process.exit(17);
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'build-command',
        provider: 'kiro',
        context: 'Reply with OK',
        options: {
          cliFeatures: {
            supportsAcpStdio: true,
          },
        },
      });

      assert.equal(response.exitCode, 2);
      assert.equal(response.envelope.ok, false);
      assert.equal(response.envelope.error.code, 'invalid-field');
      assert.equal(response.envelope.error.field, 'options.cliFeatures.supportsAcpStdio');
      assert.match(response.envelope.error.message, /does not advertise ACP stdio support/i);
    }
  );
});

test('build-command uses Pi JSON mode with discovery disabled and schema prompt fallback', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'pi',
    context: 'Return JSON.',
    options: {
      outputFormat: 'json',
      cwd: '/tmp/worktree',
      jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      modelSpec: { model: 'openai/gpt-5.5' },
      cliFeatures: {
        supportsJsonMode: true,
        supportsNoSession: true,
        supportsNoExtensions: true,
        supportsNoSkills: true,
        supportsNoPromptTemplates: true,
        supportsNoContextFiles: true,
        supportsNoApprove: true,
        supportsModel: true,
      },
    },
  });

  const { commandSpec } = response.envelope.result;
  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.schemaMode, 'prompt');
  assert.equal(commandSpec.binary, 'pi');
  assert.equal(commandSpec.cwd, '/tmp/worktree');
  assert.deepEqual(commandSpec.args.slice(0, 11), [
    '--mode',
    'json',
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-approve',
    '--model',
    'openai/gpt-5.5',
    commandSpec.args.at(-1),
  ]);
  assert.ok(commandSpec.args.at(-1).includes('## OUTPUT FORMAT (CRITICAL - REQUIRED)'));
  assert.ok(response.envelope.warnings.some((warning) => warning.code === 'pi-jsonschema'));
});

test('build-command rejects Pi resume/continue session control requests', () => {
  const resumed = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'pi',
    context: 'Return JSON.',
    options: {
      resumeSessionId: 'ignored-session',
      cliFeatures: {
        supportsJsonMode: true,
      },
    },
  });

  assert.equal(resumed.exitCode, 2);
  assert.equal(resumed.envelope.ok, false);
  assert.equal(resumed.envelope.error.code, 'invalid-field');
  assert.equal(resumed.envelope.error.field, 'options.resumeSessionId');

  const emptyResumed = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'pi',
    context: 'Return JSON.',
    options: {
      resumeSessionId: '',
      cliFeatures: {
        supportsJsonMode: true,
      },
    },
  });

  assert.equal(emptyResumed.exitCode, 2);
  assert.equal(emptyResumed.envelope.ok, false);
  assert.equal(emptyResumed.envelope.error.code, 'invalid-field');
  assert.equal(emptyResumed.envelope.error.field, 'options.resumeSessionId');

  const continued = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'pi',
    context: 'Return JSON.',
    options: {
      continueSession: true,
      cliFeatures: {
        supportsJsonMode: true,
      },
    },
  });

  assert.equal(continued.exitCode, 2);
  assert.equal(continued.envelope.ok, false);
  assert.equal(continued.envelope.error.code, 'invalid-field');
  assert.equal(continued.envelope.error.field, 'options.continueSession');
});

test('build-command ignores undefined Pi resumeSessionId values', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'pi',
    context: 'Return JSON.',
    options: {
      resumeSessionId: undefined,
      cliFeatures: {
        supportsJsonMode: true,
      },
    },
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.commandSpec.binary, 'pi');
  assert.equal(response.envelope.result.commandSpec.args.at(-1), 'Return JSON.');
});

test('build-command keeps Pi JSON-mode args when only version probe returns output', () => {
  withFakeProviderCli(
    'pi',
    fakePiScript(`
if (process.argv.includes('--help')) {
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('0.80.3\\n');
  process.exit(0);
}
process.stderr.write('unknown option -h\\n');
process.exit(1);
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'build-command',
        provider: 'pi',
        context: 'Return JSON.',
        options: {
          outputFormat: 'json',
        },
      });

      const args = response.envelope.result.commandSpec.args;
      assert.equal(response.exitCode, 0);
      assert.equal(response.envelope.ok, true);
      assert.deepEqual(args.slice(0, 8), [
        '--mode',
        'json',
        '--no-session',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--no-approve',
      ]);
      assert.equal(args.at(-1), 'Return JSON.');
    }
  );
});

test('build-command resolves Codex settings default level and model overrides', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-provider-settings-'));
  const settingsFile = path.join(tempDir, 'settings.json');

  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      providerSettings: {
        codex: {
          defaultLevel: 'level3',
          levelOverrides: {
            level3: {
              model: 'gpt-5.5',
              reasoningEffort: 'xhigh',
            },
          },
        },
      },
    })
  );

  try {
    withFakeProviderCli(
      'codex',
      fakeCodexScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: codex exec --json --skip-git-repo-check -m --config\\n');
  process.exit(0);
}
process.exit(17);
`),
      () =>
        withTempEnv({ ZEROSHOT_SETTINGS_FILE: settingsFile }, () => {
          const response = runExecutable({
            schemaVersion: 1,
            command: 'build-command',
            provider: 'codex',
            context: 'ctx',
            options: {
              outputFormat: 'json',
            },
          });

          const args = response.envelope.result.commandSpec.args;
          assert.equal(response.exitCode, 0);
          assert.equal(response.envelope.ok, true);
          assert.ok(args.includes('--json'));
          assert.deepEqual(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2), [
            '-m',
            'gpt-5.5',
          ]);
          assert.deepEqual(args.slice(args.indexOf('--config'), args.indexOf('--config') + 2), [
            '--config',
            'model_reasoning_effort="xhigh"',
          ]);
        })
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('probe attests Codex and OpenCode web-search version floors', () => {
  const codexHelp = 'Usage: codex exec --config --json resume';
  for (const [versionText, expected] of [
    ['codex-cli 0.146.0', true],
    ['codex-cli 0.146.0beta', false],
    ['codex-cli 0.145.9', false],
    ['codex-cli unknown', false],
    ['', false],
  ]) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'probe',
      provider: 'codex',
      helpText: codexHelp,
      versionText,
    });
    assert.equal(response.envelope.result.capabilities.supportsWebSearch, expected);
  }

  const missingConfig = runExecutable({
    schemaVersion: 1,
    command: 'probe',
    provider: 'codex',
    helpText: 'Usage: codex exec --json resume',
    versionText: 'codex-cli 0.146.0',
  });
  assert.equal(missingConfig.envelope.result.capabilities.supportsWebSearch, false);

  for (const [versionText, expected] of [
    ['1.0.137', true],
    ['opencode 1.0.137garbage', false],
    ['opencode 1.0.136', false],
    ['dev', false],
  ]) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'probe',
      provider: 'opencode',
      helpText: 'Usage: opencode run --session --continue',
      versionText,
    });
    assert.equal(response.envelope.result.capabilities.supportsWebSearch, expected);
  }

  for (const [versionText, expected] of [
    ['1.17.20', true],
    ['opencode 1.17.20', true],
    ['opencode 1.17.19', false],
    ['opencode 1.17.20-beta.1', false],
    ['dev', false],
  ]) {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'probe',
      provider: 'opencode',
      helpText: 'Usage: opencode run --agent',
      versionText,
    });
    assert.equal(response.envelope.result.capabilities.supportsRecoveryIsolation, expected);
  }
});

test('probe and build-command distinguish requested and effective Codex search', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-web-search-settings-'));
  const settingsFile = path.join(tempDir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ providerSettings: { codex: { webSearch: true } } })
  );

  try {
    withTempEnv({ ZEROSHOT_SETTINGS_FILE: settingsFile }, () => {
      const probe = runExecutable({
        schemaVersion: 1,
        command: 'probe',
        provider: 'codex',
        helpText: 'Usage: codex exec --config resume',
        versionText: 'codex-cli 0.146.0',
      });
      assert.deepEqual(probe.envelope.result.configuration.webSearch, {
        requested: true,
        effective: true,
      });

      withFakeProviderCli(
        'codex',
        fakeCodexScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: codex exec --config --json resume\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.146.0\\n');
  process.exit(0);
}
process.exit(17);
`),
        () => {
          const built = runExecutable({
            schemaVersion: 1,
            command: 'build-command',
            provider: 'codex',
            context: 'ctx',
            options: { resumeSessionId: 'thread-1' },
          });
          assert.equal(built.exitCode, 0);
          assert.deepEqual(built.envelope.result.configuration.webSearch, {
            requested: true,
            effective: true,
          });
          assert.deepEqual(built.envelope.result.commandSpec.args.slice(0, 4), [
            'exec',
            '--config',
            'web_search="live"',
            'resume',
          ]);
        }
      );
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('enabled search retains fail-closed resume proof with partial feature overrides', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-search-resume-proof-'));
  const settingsFile = path.join(tempDir, 'settings.json');

  try {
    for (const provider of ['codex', 'opencode']) {
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({ providerSettings: { [provider]: { webSearch: true } } })
      );
      const script =
        provider === 'codex'
          ? fakeCodexScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: codex exec --config --json\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.146.0\\n');
  process.exit(0);
}
process.exit(17);
`)
          : `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: opencode run --format\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.137\\n');
  process.exit(0);
}
process.exit(17);
`;

      withFakeProviderCli(provider, script, () =>
        withTempEnv({ ZEROSHOT_SETTINGS_FILE: settingsFile }, () => {
          const response = runExecutable({
            schemaVersion: 1,
            command: 'build-command',
            provider,
            context: 'resume',
            options: {
              resumeSessionId: 'session-1',
              cliFeatures: { supportsJson: true },
            },
          });
          assert.equal(response.envelope.ok, false);
          assert.match(response.envelope.error.message, /cannot safely run continuation context/);
        })
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('build-command returns structured unsupported-capability for old Codex', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-web-search-old-'));
  const settingsFile = path.join(tempDir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ providerSettings: { codex: { webSearch: true } } })
  );

  try {
    withFakeProviderCli(
      'codex',
      fakeCodexScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: codex exec --config resume\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.145.0\\n');
  process.exit(0);
}
process.exit(17);
`),
      () =>
        withTempEnv({ ZEROSHOT_SETTINGS_FILE: settingsFile }, () => {
          const response = runExecutable({
            schemaVersion: 1,
            command: 'build-command',
            provider: 'codex',
            context: 'ctx',
            options: {
              webSearch: true,
              cliFeatures: { supportsWebSearch: true },
            },
          });
          assert.equal(response.envelope.ok, false);
          assert.equal(response.envelope.error.code, 'unsupported-capability');
          assert.equal(response.envelope.error.field, 'options.webSearch');
          assert.match(response.envelope.error.message, /version >= 0\.146\.0/);
        })
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('build-command applies OpenCode search env to fresh and resumed commands', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-opencode-search-'));
  const settingsFile = path.join(tempDir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ providerSettings: { opencode: { webSearch: true } } })
  );
  const script = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: opencode run --session --continue --format --model --variant\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.137\\n');
  process.exit(0);
}
process.exit(17);
`;

  try {
    withFakeProviderCli('opencode', script, () =>
      withTempEnv({ ZEROSHOT_SETTINGS_FILE: settingsFile }, () => {
        const fresh = runExecutable({
          schemaVersion: 1,
          command: 'build-command',
          provider: 'opencode',
          context: 'fresh',
          env: { KEEP_ME: 'yes' },
        });
        assert.deepEqual(fresh.envelope.result.commandSpec.env, {
          KEEP_ME: '[REDACTED:KEEP_ME]',
          OPENCODE_ENABLE_EXA: '[REDACTED:OPENCODE_ENABLE_EXA]',
        });
        assert.deepEqual(fresh.envelope.result.configuration.webSearch, {
          requested: true,
          effective: true,
        });

        const resumed = runExecutable({
          schemaVersion: 1,
          command: 'build-command',
          provider: 'opencode',
          context: 'resume',
          options: { resumeSessionId: 'session-1' },
        });
        assert.deepEqual(resumed.envelope.result.commandSpec.args.slice(-3), [
          '--session',
          'session-1',
          'resume',
        ]);
        assert.equal(
          resumed.envelope.result.commandSpec.env.OPENCODE_ENABLE_EXA,
          '[REDACTED:OPENCODE_ENABLE_EXA]'
        );
      })
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('probe reports capabilities and credential presence without exposing values', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'probe',
    provider: 'claude',
    helpText:
      'claude --output-format stream-json --json-schema --dangerously-skip-permissions --include-partial-messages --verbose --model',
    env: {
      ANTHROPIC_API_KEY: 'sk-ant-secret',
    },
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.provider.id, 'claude');
  assert.equal(response.envelope.result.credentials[0].key, 'ANTHROPIC_API_KEY');
  assert.equal(response.envelope.result.credentials[0].present, true);
  assertNoSecret(response.envelope, 'sk-ant-secret');
});

test('probe reads live Codex help when helpText is not supplied', () => {
  withFakeProviderCli(
    'codex',
    fakeCodexScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: codex exec --json --skip-git-repo-check\\n');
  process.exit(0);
}
process.exit(17);
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'probe',
        provider: 'codex',
      });

      assert.equal(response.exitCode, 0);
      assert.equal(response.envelope.ok, true);
      assert.equal(response.envelope.result.capabilities.supportsJson, true);
      assert.equal(response.envelope.result.capabilities.supportsOutputSchema, false);
      assert.equal(response.envelope.result.capabilities.unknown, false);
    }
  );
});

test('probe requires Pi help or version output when helpText is not supplied', () => {
  withFakeProviderCli(
    'pi',
    fakePiScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: pi --mode json --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('0.80.3\\n');
  process.exit(0);
}
process.exit(17);
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'probe',
        provider: 'pi',
      });

      assert.equal(response.exitCode, 0);
      assert.equal(response.envelope.ok, true);
      assert.equal(response.envelope.result.available, true);
      assert.equal(response.envelope.result.provider.id, 'pi');
      assert.equal(response.envelope.result.capabilities.supportsJsonMode, true);
      assert.equal(response.envelope.result.capabilities.supportsNoApprove, true);
      assert.equal(response.envelope.result.versionText, '0.80.3');
    }
  );
});

test('probe exposes ACP CLI capabilities for Kiro', () => {
  withFakeProviderCli(
    'kiro-cli',
    fakeKiroScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: kiro-cli acp\\n');
  process.exit(0);
}
process.exit(17);
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'probe',
        provider: 'kiro',
      });

      assert.equal(response.exitCode, 0);
      assert.equal(response.envelope.ok, true);
      assert.equal(response.envelope.result.available, true);
      assert.equal(response.envelope.result.provider.id, 'kiro');
      assert.equal(response.envelope.result.capabilities.supportsAcpStdio, true);
      assert.equal(response.envelope.result.capabilities.supportsPermissionRequests, false);
      assert.equal(response.envelope.result.capabilities.supportsTerminalTools, false);
    }
  );
});

test('build-command builds Copilot autonomous argv with schema prompt fallback', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'copilot',
    context: 'Return JSON.',
    options: {
      outputFormat: 'json',
      cwd: '/tmp/worktree',
      autoApprove: true,
      jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      modelSpec: { model: 'gpt-5.2' },
      cliFeatures: {
        supportsJsonOutput: true,
        supportsModel: true,
        supportsAllowAll: true,
        supportsNoAskUser: true,
        supportsAddDir: true,
      },
    },
  });

  const { commandSpec } = response.envelope.result;
  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.schemaMode, 'prompt');
  assert.equal(commandSpec.binary, 'copilot');
  assert.equal(commandSpec.cwd, '/tmp/worktree');
  assert.deepEqual(commandSpec.args, [
    '--output-format',
    'json',
    '--model',
    'gpt-5.2',
    '--add-dir',
    '/tmp/worktree',
    '--allow-all',
    '--no-ask-user',
    '-p',
    commandSpec.args.at(-1),
  ]);
  assert.equal(commandSpec.args.at(-2), '-p');
  assert.ok(commandSpec.args.at(-1).includes('## OUTPUT FORMAT (CRITICAL - REQUIRED)'));
  assert.ok(response.envelope.warnings.some((warning) => warning.code === 'copilot-jsonschema'));
});

test('build-command omits Copilot approval flags when autoApprove is not requested', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'copilot',
    context: 'Return JSON.',
    options: {
      outputFormat: 'json',
      cliFeatures: {
        supportsJsonOutput: true,
        supportsModel: true,
        supportsAllowAll: true,
        supportsNoAskUser: true,
        supportsAddDir: true,
      },
    },
  });

  const { commandSpec } = response.envelope.result;
  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(commandSpec.args.includes('--allow-all'), false);
  assert.equal(commandSpec.args.includes('--no-ask-user'), false);
  assert.equal(commandSpec.args.at(-2), '-p');
  assert.equal(commandSpec.args.at(-1), 'Return JSON.');
});

test('build-command keeps Copilot JSON output args when only version probe returns output', () => {
  withFakeProviderCli(
    'copilot',
    fakeCopilotScript(`
if (process.argv.includes('--help')) {
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
process.stderr.write('unknown option -h\\n');
process.exit(1);
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'build-command',
        provider: 'copilot',
        context: 'Return JSON.',
        options: {
          outputFormat: 'json',
        },
      });

      const args = response.envelope.result.commandSpec.args;
      assert.equal(response.exitCode, 0);
      assert.equal(response.envelope.ok, true);
      assert.deepEqual(args.slice(0, 2), ['--output-format', 'json']);
      assert.equal(args.at(-2), '-p');
      assert.equal(args.at(-1), 'Return JSON.');
    }
  );
});

test('build-command emits one Copilot --additional-mcp-config flag per mcpConfig entry', () => {
  const response = runExecutable({
    schemaVersion: 1,
    command: 'build-command',
    provider: 'copilot',
    context: 'Do work.',
    options: {
      autoApprove: true,
      mcpConfig: ['{"mcpServers":{"a":{"command":"a-bin"}}}', '@/tmp/servers.json'],
      cliFeatures: {
        supportsAllowAll: true,
        supportsNoAskUser: true,
        supportsMcpConfig: true,
      },
    },
  });

  const { commandSpec } = response.envelope.result;
  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.deepEqual(commandSpec.args, [
    '--allow-all',
    '--no-ask-user',
    '--additional-mcp-config',
    '{"mcpServers":{"a":{"command":"a-bin"}}}',
    '--additional-mcp-config',
    '@/tmp/servers.json',
    '-p',
    'Do work.',
  ]);
  assert.equal(
    response.envelope.warnings.some((warning) => warning.code === 'copilot-mcp-config'),
    false
  );
});

test('build-command gates Copilot MCP config on feature detection and warns when unsupported', () => {
  withFakeProviderCli(
    'copilot',
    fakeCopilotScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: copilot -p <prompt> --output-format json --model <m> --allow-all --no-ask-user --add-dir <dir>\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
process.exit(0);
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'build-command',
        provider: 'copilot',
        context: 'Do work.',
        options: {
          mcpConfig: ['{"mcpServers":{"a":{"command":"a-bin"}}}'],
        },
      });

      const { commandSpec } = response.envelope.result;
      assert.equal(response.exitCode, 0);
      assert.equal(response.envelope.ok, true);
      assert.equal(commandSpec.args.includes('--additional-mcp-config'), false);
      assert.ok(
        response.envelope.warnings.some((warning) => warning.code === 'copilot-mcp-config'),
        'expected a copilot-mcp-config warning when the CLI lacks --additional-mcp-config'
      );
    }
  );
});
