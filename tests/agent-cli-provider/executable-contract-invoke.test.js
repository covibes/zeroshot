const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  assertNoSecret,
  assertUnsupportedAcpResponse,
  fakeCodexScript,
  fakeCopilotScript,
  fakeKiroScript,
  fakeOmpScript,
  fakePiScript,
  invokeCodexSchemaRequest,
  runExecutable,
  runProviderExecutable,
  runnerResult,
  withCurrentPiCli,
  withFakeProviderCli,
  withKiroWithoutAcp,
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
  withKiroWithoutAcp(() => {
    const response = runExecutable({
      schemaVersion: 1,
      command: 'invoke',
      provider: 'kiro',
      context: 'Reply with OK',
      timeoutMs: 300,
    });
    assertUnsupportedAcpResponse(response);
  });
});

test('invoke ignores caller ACP support overrides when runtime probe rejects ACP stdio', () => {
  withKiroWithoutAcp(() => {
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
    assertUnsupportedAcpResponse(response);
  });
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
  process.stdout.write('0.84.1\\n');
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
            assert.deepEqual(response.envelope.result.commandSpec.args.slice(0, 9), [
              '--mode',
              'json',
              '--no-session',
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
  const response = await withCurrentPiCli(() =>
    runProviderExecutable(
      {
        schemaVersion: 1,
        command: 'invoke',
        provider: 'pi',
        context: 'Authenticate.',
        options: { outputFormat: 'json' },
      },
      {
        runner: () =>
          runnerResult({
            stdout: fs.readFileSync(fixturePath, 'utf8'),
            exitCode: 0,
            signal: null,
          }),
      }
    )
  );

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.events.at(-1).type, 'result');
  assert.equal(response.envelope.result.events.at(-1).error, 'authentication required: run /login');
  assert.equal(response.envelope.result.classification.retryable, false);
  assert.equal(response.envelope.result.classification.kind, 'permanent-pattern');
});

test('invoke parses only Pi stdout while preserving ordinary stderr evidence', async () => {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'pi', 'text.jsonl');
  const response = await withCurrentPiCli(() =>
    runProviderExecutable(
      {
        schemaVersion: 1,
        command: 'invoke',
        provider: 'pi',
        context: 'Reply once.',
      },
      {
        runner: () =>
          runnerResult({
            stdout: fs.readFileSync(fixturePath, 'utf8'),
            stderr: 'extension diagnostic: provider initialized',
          }),
      }
    )
  );

  assert.equal(response.envelope.result.events.at(-1).success, true);
  assert.equal(
    response.envelope.result.evidence.stderr,
    'extension diagnostic: provider initialized'
  );
  assert.deepEqual(response.envelope.result.diagnostics, []);
});

test('invoke classifies a clean Pi exit before agent_settled as an incomplete protocol', async () => {
  const response = await withCurrentPiCli(() =>
    runProviderExecutable(
      {
        schemaVersion: 1,
        command: 'invoke',
        provider: 'pi',
        context: 'Finish the turn.',
      },
      {
        runner: () =>
          runnerResult({
            stdout: '{"type":"session","version":3,"id":"incomplete"}\n',
            exitCode: 0,
            signal: null,
          }),
      }
    )
  );

  assert.equal(response.envelope.result.events.length, 1);
  assert.equal(response.envelope.result.events[0].success, false);
  assert.match(response.envelope.result.events[0].error, /before agent_settled/i);
  assert.equal(response.envelope.result.classification.retryable, true);
  assert.equal(response.envelope.result.classification.kind, 'unknown-retryable');
});

test('invoke preserves Pi startup authentication failure over missing settlement', async () => {
  const response = await withCurrentPiCli(() =>
    runProviderExecutable(
      {
        schemaVersion: 1,
        command: 'invoke',
        provider: 'pi',
        context: 'Start the turn.',
      },
      {
        runner: () =>
          runnerResult({
            stdout: '{"type":"session","version":3,"id":"startup"}\n',
            stderr:
              'No API key found for the selected model.\nUse /login to log into a provider.\n',
            exitCode: 1,
            signal: null,
          }),
      }
    )
  );

  assert.equal(response.envelope.result.events.length, 1);
  assert.match(response.envelope.result.events[0].error, /before agent_settled/i);
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

function createOmpRpcSettings(tempDir) {
  const settingsFile = path.join(tempDir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ providerSettings: { omp: { transport: 'rpc' } } }),
    { mode: 0o600 }
  );
  return settingsFile;
}

function assertOmpRpcInvokeResponse(response) {
  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.commandSpec.binary, 'omp');
  const args = response.envelope.result.commandSpec.args;
  assert.deepEqual(args.slice(0, 3), ['--mode', 'rpc', '--no-session']);
  assert.equal(args.includes('--approval-mode'), true);
  assert.equal(args[args.indexOf('--approval-mode') + 1], 'yolo');
  assert.equal(args.includes('--no-title'), true);
  assert.equal(args.includes('--config'), true);
  assert.deepEqual(response.envelope.result.events, [
    { type: 'text', text: 'OMP invoke OK' },
    {
      type: 'result',
      success: true,
      result: 'OMP invoke OK',
      error: null,
      inputTokens: 5,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      cost: { total: 0.001 },
      modelUsage: {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.001 },
      },
    },
  ]);
  assert.equal(response.envelope.result.cleanup.length, 1);
  assert.equal(response.envelope.result.cleanup[0].removed, true);
  assert.equal(fs.existsSync(path.dirname(args[args.indexOf('--config') + 1])), false);
}

test('invoke runs the omp rpc-stdio lane through the shared driver, from a real CLI probe', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-worktree-'));
  const settingsFile = createOmpRpcSettings(tempDir);

  try {
    withFakeProviderCli(
      'omp',
      fakeOmpScript(`
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write([
    'Usage: omp [command] [options]',
    'Commands:',
    '  rpc                  Run in RPC mode',
    'Options:',
    '  --config <path>',
    '  --model <selector>',
    '  --thinking <level>',
    '  --approval-mode <mode>',
    '  --no-title',
    '  --no-session',
    '  --session-dir <dir>',
    '  --resume <id>',
  ].join('\\n') + '\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write('omp 17.2.1\\n');
  process.exit(0);
}
const readline = require('node:readline');
function emit(frame) { process.stdout.write(JSON.stringify(frame) + '\\n'); }
emit({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
emit({ type: 'available_commands_update', commands: [] });
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (!command || typeof command !== 'object') return;
  if (command.type === 'negotiate_protocol') {
    emit({ id: command.id, type: 'response', command: 'negotiate_protocol', success: true });
    return;
  }
  if (command.type === 'get_state') {
    emit({
      id: command.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: { model: { provider: 'anthropic', id: '@default' }, thinkingLevel: 'medium' },
    });
    return;
  }
  if (command.type === 'prompt') {
    emit({ id: command.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });
    emit({ type: 'agent_start' });
    emit({ type: 'turn_start' });
    emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'OMP invoke OK' } });
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OMP invoke OK' }] } });
    emit({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'OMP invoke OK' }],
        stopReason: 'stop',
        usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
      },
    });
    emit({ type: 'agent_end', messages: [] });
    return;
  }
  if (command.type === 'abort') {
    emit({ type: 'agent_end', messages: [] });
  }
});
`),
      () => {
        const response = withTempEnv({ ZEROSHOT_SETTINGS_FILE: settingsFile }, () =>
          runExecutable({
            schemaVersion: 1,
            command: 'invoke',
            provider: 'omp',
            context: 'Reply with OMP invoke OK',
            timeoutMs: 5000,
            options: {
              cwd: tempDir,
            },
          })
        );

        assertOmpRpcInvokeResponse(response);
      }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
