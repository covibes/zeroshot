const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  assertNoSecret,
  fakeCodexScript,
  fakeCopilotScript,
  fakeKiroScript,
  fakePiScript,
  invokeCodexSchemaRequest,
  runExecutable,
  runProviderExecutable,
  runnerResult,
  withFakeProviderCli,
  withTempEnv,
} = require('./executable-contract-helpers.cjs');

test('invoke returns redacted terminal evidence, parsed events, status, timing, and cleanup', async () => {
  let runnerCommand = null;
  const secret = 'super-secret-token';
  const response = await runProviderExecutable(
    invokeCodexSchemaRequest({
      env: {
        CUSTOM_TOKEN: secret,
      },
    }),
    {
      runner: (commandSpec) => {
        runnerCommand = commandSpec;
        assert.equal(fs.existsSync(commandSpec.cleanup[0]), true);
        return runnerResult({
          stdout: JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: `done ${secret}` }],
            },
          }),
          stderr: `warn ${secret}`,
          durationMs: 12,
        });
      },
    }
  );

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.exitCode, 0);
  assert.equal(response.envelope.result.signal, null);
  assert.equal(response.envelope.result.durationMs, 12);
  assert.equal(response.envelope.result.evidence.stdout.includes(secret), false);
  assert.equal(response.envelope.result.evidence.stderr.includes(secret), false);
  assert.equal(response.envelope.result.events[0].type, 'text');
  assert.equal(response.envelope.result.events[0].text.includes(secret), false);
  assert.equal(response.envelope.result.cleanup[0].removed, true);
  assert.equal(fs.existsSync(runnerCommand.cleanup[0]), false);
  assertNoSecret(response.envelope, secret);
});

test('invoke parses bundled gateway runner events', async () => {
  let runnerCommand = null;
  const secret = 'gateway-secret';
  const response = await runProviderExecutable(
    {
      schemaVersion: 1,
      command: 'invoke',
      provider: 'gateway',
      context: 'Edit note.txt',
      options: {
        cwd: '/tmp/gateway-project',
        gateway: {
          baseUrl: 'http://127.0.0.1:11434',
          apiKey: secret,
          model: 'openrouter/test-model',
          toolPolicy: {
            roots: ['.'],
            commands: ['node'],
          },
        },
      },
    },
    {
      runner: (commandSpec) => {
        runnerCommand = commandSpec;
        return runnerResult({
          stdout: [
            JSON.stringify({ type: 'text', text: 'editing' }),
            JSON.stringify({
              type: 'tool_call',
              toolName: 'read_file',
              toolId: 'tool-1',
              input: { path: 'note.txt' },
            }),
            JSON.stringify({
              type: 'tool_result',
              toolId: 'tool-1',
              content: { path: 'note.txt', content: 'before' },
              isError: false,
            }),
            JSON.stringify({ type: 'result', success: true, result: { text: 'done' } }),
          ].join('\n'),
        });
      },
    }
  );

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(runnerCommand.binary, process.execPath);
  assert.match(runnerCommand.args[0], /gateway-runner\.js$/);
  assert.equal(runnerCommand.env.ZEROSHOT_GATEWAY_API_KEY, secret);
  assert.equal(runnerCommand.env.ZEROSHOT_GATEWAY_REQUEST.includes(secret), false);
  assert.deepEqual(
    response.envelope.result.events.map((event) => event.type),
    ['text', 'tool_call', 'tool_result', 'result']
  );
});

test('invoke redacts gateway api keys leaked by the runner', async () => {
  const secret = 'gateway-plain-secret';
  const headerSecret = 'custom-header-secret-42';
  const response = await runProviderExecutable(
    {
      schemaVersion: 1,
      command: 'invoke',
      provider: 'gateway',
      context: 'Reply with ok.',
      options: {
        gateway: {
          baseUrl: 'http://127.0.0.1:11434',
          apiKey: secret,
          headers: {
            'X-API-Key': headerSecret,
          },
          model: 'openrouter/test-model',
          toolPolicy: {
            roots: [process.cwd()],
            commands: [],
          },
        },
      },
    },
    {
      runner: (commandSpec) => {
        const request = JSON.parse(commandSpec.env.ZEROSHOT_GATEWAY_REQUEST);
        const headerEnvKey = request.gatewayHeaderEnv?.['X-API-Key'];
        const leakedHeaderSecret =
          (typeof headerEnvKey === 'string' && commandSpec.env[headerEnvKey]) ||
          request.gateway?.headers?.['X-API-Key'] ||
          '';
        return runnerResult({
          stdout: `leak ${secret} ${leakedHeaderSecret}`,
          stderr: `auth failed ${secret} ${leakedHeaderSecret}`,
        });
      },
    }
  );

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.evidence.stdout.includes(secret), false);
  assert.equal(response.envelope.result.evidence.stderr.includes(secret), false);
  assert.equal(response.envelope.result.evidence.stdout.includes(headerSecret), false);
  assert.equal(response.envelope.result.evidence.stderr.includes(headerSecret), false);
  assertNoSecret(response.envelope, secret);
  assertNoSecret(response.envelope, headerSecret);
});

test('invoke removes schema cleanup files when runner rejects', async () => {
  let cleanupPath = null;
  const response = await runProviderExecutable(invokeCodexSchemaRequest(), {
    runner: (commandSpec) => {
      cleanupPath = commandSpec.cleanup[0];
      assert.equal(fs.existsSync(cleanupPath), true);
      return Promise.reject(new Error('spawn ENOENT'));
    },
  });

  assert.equal(response.exitCode, 5);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.error.code, 'internal-error');
  assert.equal(fs.existsSync(cleanupPath), false);
});

test('invoke redacts authEnv values from runner rejection envelopes', async () => {
  const secret = 'authenv-secret-123';
  const response = await runProviderExecutable(
    {
      schemaVersion: 1,
      command: 'invoke',
      provider: 'claude',
      context: 'hi',
      options: {
        authEnv: {
          CUSTOM: secret,
        },
      },
    },
    {
      runner: () => Promise.reject(new Error(`runner failed ${secret}`)),
    }
  );

  assert.equal(response.exitCode, 5);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.error.code, 'internal-error');
  assert.equal(response.envelope.error.message.includes(secret), false);
  assertNoSecret(response.envelope, secret);
});

test('invoke exposes timeout evidence and cleanup when provider times out', async () => {
  let cleanupPath = null;
  const response = await runProviderExecutable(invokeCodexSchemaRequest({ timeoutMs: 50 }), {
    runner: (commandSpec) => {
      cleanupPath = commandSpec.cleanup[0];
      assert.equal(fs.existsSync(cleanupPath), true);
      return runnerResult({
        exitCode: null,
        signal: 'SIGKILL',
        durationMs: 151,
        timedOut: true,
        timeoutMs: 50,
        stderr: 'still running',
      });
    },
  });

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.timedOut, true);
  assert.equal(response.envelope.result.timeoutMs, 50);
  assert.equal(response.envelope.result.exitCode, null);
  assert.equal(response.envelope.result.signal, 'SIGKILL');
  assert.equal(response.envelope.result.classification.retryable, true);
  assert.equal(response.envelope.evidence.timedOut, true);
  assert.equal(response.envelope.evidence.timeoutMs, 50);
  assert.equal(response.envelope.result.cleanup[0].removed, true);
  assert.equal(fs.existsSync(cleanupPath), false);
});

test('invoke redacts provider credentials inherited from process env', async () => {
  const secret = 'plain-provider-secret';
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret;

  try {
    const response = await runProviderExecutable(
      {
        schemaVersion: 1,
        command: 'invoke',
        provider: 'codex',
        context: 'Return JSON.',
        options: {
          outputFormat: 'json',
          cliFeatures: {
            supportsJson: true,
            supportsSkipGitRepoCheck: true,
          },
        },
      },
      {
        runner: () =>
          runnerResult({
            stdout: `leak ${secret}`,
            stderr: `auth failed for ${secret}`,
          }),
      }
    );

    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    assert.equal(response.envelope.result.evidence.stdout.includes(secret), false);
    assert.equal(response.envelope.result.evidence.stderr.includes(secret), false);
    assertNoSecret(response.envelope, secret);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previous;
    }
  }
});

test('invoke closes provider stdin and parses output from the spawned process', () => {
  withFakeProviderCli(
    'codex',
    fakeCodexScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: codex exec --json --skip-git-repo-check\\n');
  process.exit(0);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'HELPER_INVOKE_OK' }],
    },
  }));
});
process.stdin.resume();
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'invoke',
        provider: 'codex',
        context: 'Reply with exactly: HELPER_INVOKE_OK',
        options: {
          outputFormat: 'json',
        },
        timeoutMs: 300,
      });

      assert.equal(response.exitCode, 0);
      assert.equal(response.envelope.ok, true);
      assert.equal(response.envelope.result.timedOut, false);
      assert.equal(response.envelope.result.exitCode, 0);
      assert.equal(response.envelope.result.events[0].type, 'text');
      assert.equal(response.envelope.result.events[0].text, 'HELPER_INVOKE_OK');
      assert.ok(response.envelope.result.commandSpec.args.includes('--json'));
    }
  );
});

test('invoke requires local OMP --resume attestation despite caller feature overrides', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-resume-attestation-'));
  const executionMarker = path.join(tempDir, 'provider-executed.json');
  const request = {
    schemaVersion: 1,
    command: 'invoke',
    provider: 'omp',
    context: 'resume prompt',
    options: {
      resumeSessionId: 'session-123',
      cliFeatures: {
        supportsModeJson: true,
        supportsPrint: true,
        supportsCwd: true,
        supportsAutoApprove: true,
        supportsModel: false,
        supportsThinking: false,
        supportsNoExtensions: false,
        supportsNoSkills: false,
        supportsNoRules: false,
        supportsNoTitle: false,
        supportsResume: true,
      },
    },
    timeoutMs: 300,
  };

  try {
    withFakeProviderCli(
      'omp',
      `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: omp --mode json -p --cwd --auto-approve --resume-latest\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('omp 1.0.0\\n');
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(executionMarker)}, JSON.stringify(process.argv.slice(2)));
`,
      () => {
        const rejected = runExecutable(request);
        assert.equal(rejected.exitCode, 2);
        assert.equal(rejected.envelope.ok, false);
        assert.equal(rejected.envelope.error.code, 'unsupported-provider-cli');
        assert.equal(rejected.envelope.error.field, 'options.resumeSessionId');
        assert.equal(fs.existsSync(executionMarker), false);
      }
    );

    withFakeProviderCli(
      'omp',
      `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: omp --mode json -p --cwd --auto-approve --resume <id>\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('omp 1.0.0\\n');
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(executionMarker)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: 'ok' },
}) + '\\n');
`,
      () => {
        const allowed = runExecutable(request);
        assert.equal(allowed.exitCode, 0);
        assert.equal(allowed.envelope.ok, true);
        assert.deepEqual(JSON.parse(fs.readFileSync(executionMarker, 'utf8')), [
          '--mode',
          'json',
          '-p',
          '--auto-approve',
          '--resume',
          'session-123',
          'resume prompt',
        ]);
      }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('invoke runs ACP stdio providers through the shared headless lane', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-kiro-worktree-'));

  try {
    withFakeProviderCli(
      'kiro-cli',
      fakeKiroScript(`
const readline = require('node:readline');
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: kiro-cli acp\\n');
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: 1 },
    }) + '\\n');
    return;
  }
  if (message.method === 'session/new') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { sessionId: 'kiro-session-1' },
    }) + '\\n');
    return;
  }
  if (message.method === 'session/prompt') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'kiro-session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'bash',
          rawInput: { command: 'pwd' },
        },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'kiro-session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status: 'completed',
          rawOutput: '/tmp/kiro',
        },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'kiro-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'Kiro invoke OK' },
        },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    }) + '\\n');
  }
});
`),
      () => {
        const response = runExecutable({
          schemaVersion: 1,
          command: 'invoke',
          provider: 'kiro',
          context: 'Reply with Kiro invoke OK',
          options: {
            cwd: tempDir,
          },
          timeoutMs: 300,
        });

        assert.equal(response.exitCode, 0);
        assert.equal(response.envelope.ok, true);
        assert.equal(response.envelope.result.commandSpec.binary, 'kiro-cli');
        assert.deepEqual(response.envelope.result.commandSpec.args, ['acp']);
        assert.deepEqual(response.envelope.result.events, [
          { type: 'tool_call', toolName: 'bash', toolId: 'tool-1', input: { command: 'pwd' } },
          { type: 'tool_result', toolId: 'tool-1', content: '/tmp/kiro', isError: false },
          { type: 'text', text: 'Kiro invoke OK' },
          {
            type: 'result',
            success: true,
            result: 'Kiro invoke OK',
            error: null,
            inputTokens: 5,
            outputTokens: 3,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            cost: null,
            modelUsage: {
              inputTokens: 5,
              outputTokens: 3,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
        ]);
      }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('invoke fails closed on ACP permission callbacks', () => {
  withFakeProviderCli(
    'kiro-cli',
    fakeKiroScript(`
const readline = require('node:readline');
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: kiro-cli acp\\n');
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: 1 },
    }) + '\\n');
    return;
  }
  if (message.method === 'session/new') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { sessionId: 'kiro-session-1' },
    }) + '\\n');
    return;
  }
  if (message.method === 'session/prompt') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 77,
      method: 'session/request_permission',
      params: { sessionId: 'kiro-session-1' },
    }) + '\\n');
    setInterval(() => {}, 1000);
  }
});
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'invoke',
        provider: 'kiro',
        context: 'trigger permission callback',
        timeoutMs: 300,
      });

      assert.equal(response.exitCode, 0);
      assert.equal(response.envelope.ok, true);
      assert.equal(response.envelope.result.timedOut, false);
      assert.equal(response.envelope.result.classification.retryable, false);
      assert.match(
        response.envelope.result.evidence.stderr,
        /kiro ACP stdio fail-closed: unsupported session\/request_permission callback/i
      );
    }
  );
});

test('invoke fails closed on malformed ACP stdout JSON', () => {
  withFakeProviderCli(
    'kiro-cli',
    fakeKiroScript(`
const readline = require('node:readline');
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: kiro-cli acp\\n');
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write('{not json}\\n');
    setInterval(() => {}, 1000);
  }
});
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'invoke',
        provider: 'kiro',
        context: 'Reply with OK',
        timeoutMs: 300,
      });

      assert.equal(response.exitCode, 0);
      assert.equal(response.envelope.ok, true);
      assert.equal(response.envelope.result.timedOut, false);
      assert.equal(response.envelope.result.classification.retryable, false);
      assert.match(
        response.envelope.result.evidence.stderr,
        /kiro ACP stdio fail-closed: malformed ACP stdout JSON/i
      );
    }
  );
});

test('invoke fails closed when ACP stdio support is not advertised', () => {
  withFakeProviderCli(
    'kiro-cli',
    fakeKiroScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: kiro-cli --version\\n');
  process.exit(0);
}
process.stderr.write('invoke should not execute kiro-cli acp');
process.exit(17);
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'invoke',
        provider: 'kiro',
        context: 'Reply with OK',
        timeoutMs: 300,
      });

      assert.equal(response.exitCode, 2);
      assert.equal(response.envelope.ok, false);
      assert.equal(response.envelope.error.code, 'invalid-field');
      assert.equal(response.envelope.error.field, 'options.cliFeatures.supportsAcpStdio');
      assert.match(response.envelope.error.message, /does not advertise ACP stdio support/i);
    }
  );
});

test('invoke ignores caller ACP support overrides when runtime probe rejects ACP stdio', () => {
  withFakeProviderCli(
    'kiro-cli',
    fakeKiroScript(`
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: kiro-cli --version\\n');
  process.exit(0);
}
process.stderr.write('invoke should not execute kiro-cli acp');
process.exit(17);
`),
    () => {
      const response = runExecutable({
        schemaVersion: 1,
        command: 'invoke',
        provider: 'kiro',
        context: 'Reply with OK',
        timeoutMs: 300,
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

test('invoke runs Pi in the requested worktree cwd and normalizes streamed JSONL', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-pi-worktree-'));
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'pi', 'tool.jsonl');

  try {
    withFakeProviderCli(
      'pi',
      fakePiScript(`
const fs = require('node:fs');
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: pi --mode json --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
process.stdout.write('0.80.3\\n');
  process.exit(0);
}
if (fs.realpathSync(process.cwd()) !== process.env.PI_EXPECT_CWD) {
  process.stderr.write(\`cwd mismatch: \${process.cwd()}\`);
  process.exit(19);
}
process.stdout.write(fs.readFileSync(process.env.PI_FIXTURE, 'utf8'));
`),
      () =>
        withTempEnv(
          {
            PI_EXPECT_CWD: fs.realpathSync(tempDir),
            PI_FIXTURE: fixturePath,
          },
          () => {
            const response = runExecutable({
              schemaVersion: 1,
              command: 'invoke',
              provider: 'pi',
              context: 'Run one tool.',
              options: {
                cwd: tempDir,
                outputFormat: 'json',
                modelSpec: { model: 'openai/gpt-5.5' },
              },
              timeoutMs: 300,
            });

            assert.equal(response.exitCode, 0);
            assert.equal(response.envelope.ok, true);
            assert.equal(response.envelope.result.exitCode, 0);
            assert.equal(response.envelope.result.commandSpec.cwd, tempDir);
            assert.deepEqual(response.envelope.result.commandSpec.args.slice(0, 10), [
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
            ]);
            assert.equal(response.envelope.result.events[0].type, 'tool_call');
            assert.equal(response.envelope.result.events.at(-1).type, 'result');
          }
        )
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('invoke classifies Pi in-band turn_end failures even when the process exits 0', async () => {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'pi', 'auth-failure.jsonl');
  const response = await runProviderExecutable(
    {
      schemaVersion: 1,
      command: 'invoke',
      provider: 'pi',
      context: 'Authenticate.',
      options: {
        outputFormat: 'json',
      },
    },
    {
      runner: () =>
        runnerResult({
          stdout: fs.readFileSync(fixturePath, 'utf8'),
          exitCode: 0,
          signal: null,
        }),
    }
  );

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.events.at(-1).type, 'result');
  assert.equal(response.envelope.result.events.at(-1).error, 'authentication required: run /login');
  assert.equal(response.envelope.result.classification.retryable, false);
  assert.equal(response.envelope.result.classification.kind, 'permanent-pattern');
});

test('invoke runs Copilot in the requested worktree cwd and normalizes streamed JSONL', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-copilot-worktree-'));
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'copilot', 'tool.jsonl');

  try {
    withFakeProviderCli(
      'copilot',
      fakeCopilotScript(`
const fs = require('node:fs');
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: copilot -p <prompt> --output-format json --model <m> --allow-all --no-ask-user --add-dir <dir>\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
if (fs.realpathSync(process.cwd()) !== process.env.COPILOT_EXPECT_CWD) {
  process.stderr.write(\`cwd mismatch: \${process.cwd()}\`);
  process.exit(19);
}
process.stdout.write(fs.readFileSync(process.env.COPILOT_FIXTURE, 'utf8'));
`),
      () =>
        withTempEnv(
          {
            COPILOT_EXPECT_CWD: fs.realpathSync(tempDir),
            COPILOT_FIXTURE: fixturePath,
          },
          () => {
            const response = runExecutable({
              schemaVersion: 1,
              command: 'invoke',
              provider: 'copilot',
              context: 'Run one tool.',
              options: {
                cwd: tempDir,
                outputFormat: 'json',
              },
              timeoutMs: 300,
            });

            assert.equal(response.exitCode, 0);
            assert.equal(response.envelope.ok, true);
            assert.equal(response.envelope.result.exitCode, 0);
            assert.equal(response.envelope.result.commandSpec.cwd, tempDir);
            const args = response.envelope.result.commandSpec.args;
            const addDirIndex = args.indexOf('--add-dir');
            assert.notEqual(addDirIndex, -1);
            assert.equal(args[addDirIndex + 1], tempDir);
            const events = response.envelope.result.events;
            assert.ok(
              events.some((event) => event.type === 'tool_call'),
              'expected a tool_call event'
            );
            assert.ok(
              events.some((event) => event.type === 'tool_result'),
              'expected a tool_result event'
            );
            assert.equal(events.at(-1).type, 'result');
            assert.equal(events.at(-1).success, true);
          }
        )
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
