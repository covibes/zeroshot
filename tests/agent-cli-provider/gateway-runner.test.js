const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const helper = require('../../lib/agent-cli-provider');
const { runGatewayRequest } = require('../../lib/agent-cli-provider/gateway-runner');
const { executeGatewayToolCall } = require('../../lib/agent-cli-provider/gateway-tools');
const {
  assertNoSecret,
  runProviderExecutable,
} = require('./executable-contract-helpers.cjs');

async function withGatewayServer(handler, fn) {
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    const json = body ? JSON.parse(body) : null;
    await handler(req, res, json);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function jsonResponse(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('gateway invoke completes deterministic edit task', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-runner-'));
  const targetFile = path.join(tempDir, 'note.txt');
  fs.writeFileSync(targetFile, 'before\n', 'utf8');

  try {
    let requestCount = 0;
    const response = await withGatewayServer((_req, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        jsonResponse(res, 200, {
          choices: [
            {
              message: {
                content: 'Reading the target file.',
                tool_calls: [
                  {
                    id: 'tool-read',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: 'note.txt' }),
                    },
                  },
                ],
              },
            },
          ],
        });
        return;
      }
      if (requestCount === 2) {
        jsonResponse(res, 200, {
          choices: [
            {
              message: {
                content: 'Applying the edit.',
                tool_calls: [
                  {
                    id: 'tool-write',
                    type: 'function',
                    function: {
                      name: 'apply_patch',
                      arguments: JSON.stringify({
                        path: 'note.txt',
                        search: 'before\n',
                        replace: 'after\n',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
        return;
      }
      jsonResponse(res, 200, {
        choices: [
          {
            message: {
              content: 'Task complete.',
            },
          },
        ],
      });
    }, (baseUrl) =>
      runProviderExecutable(
        JSON.stringify({
          schemaVersion: 1,
          command: 'invoke',
          provider: 'gateway',
          context: 'Update note.txt from before to after.',
          options: {
            cwd: tempDir,
            gateway: {
              baseUrl,
              apiKey: 'gateway-test-key',
              model: 'openrouter/test-model',
              toolPolicy: {
                roots: ['.'],
                commands: ['node'],
              },
            },
          },
          timeoutMs: 2_000,
        })
      )
    );

    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    assert.equal(fs.readFileSync(targetFile, 'utf8'), 'after\n');
    assert.deepEqual(
      response.envelope.result.events.map((event) => event.type),
      ['text', 'tool_call', 'tool_result', 'text', 'tool_call', 'tool_result', 'text', 'result']
    );
    assert.equal(response.envelope.result.events.at(-1).success, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gateway sends Anthropic-compatible requests through the configured base URL', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-anthropic-'));
  fs.writeFileSync(path.join(tempDir, 'note.txt'), 'gateway note\n', 'utf8');

  try {
    const requests = [];
    const response = await withGatewayServer((req, res, json) => {
      requests.push({ url: req.url, headers: req.headers, body: json });
      if (requests.length === 1) {
        jsonResponse(res, 200, {
          content: [
            { type: 'text', text: 'Reading the target file.' },
            {
              type: 'tool_use',
              id: 'tool-read',
              name: 'read_file',
              input: { path: 'note.txt' },
            },
          ],
        });
        return;
      }
      jsonResponse(res, 200, {
        content: [{ type: 'text', text: 'Task complete.' }],
      });
    }, (baseUrl) =>
      runProviderExecutable(
        JSON.stringify({
          schemaVersion: 1,
          command: 'invoke',
          provider: 'gateway',
          context: 'Read note.txt.',
          options: {
            cwd: tempDir,
            gateway: {
              protocol: 'anthropic',
              baseUrl: `${baseUrl}/anthropic`,
              apiKey: 'gateway-test-key',
              model: 'MiniMax-M3',
              maxTokens: 4096,
              toolPolicy: {
                roots: ['.'],
                commands: [],
              },
            },
          },
          timeoutMs: 2_000,
        })
      )
    );

    assert.equal(response.exitCode, 0);
    assert.equal(response.envelope.ok, true);
    assert.deepEqual(requests.map((request) => request.url), [
      '/anthropic/v1/messages',
      '/anthropic/v1/messages',
    ]);
    assert.equal(requests[0].headers['x-api-key'], 'gateway-test-key');
    assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(requests[0].body.model, 'MiniMax-M3');
    assert.equal(requests[0].body.max_tokens, 4096);
    assert.equal(requests[0].body.messages[0].role, 'user');
    assert.equal(requests[0].body.tools[0].input_schema.type, 'object');
    assert.equal(requests[1].body.messages[1].role, 'assistant');
    assert.equal(requests[1].body.messages[1].content[1].type, 'tool_use');
    assert.equal(requests[1].body.messages[2].content[0].type, 'tool_result');
    assert.equal(response.envelope.result.events.at(-1).success, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gateway rejects invalid config as permanent failures', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-invalid-'));

  try {
    for (const gateway of [
      {
        baseUrl: 'not-a-url',
        apiKey: 'secret',
        model: 'test-model',
        toolPolicy: { roots: ['.'], commands: [] },
      },
      {
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'secret',
        model: '',
        toolPolicy: { roots: ['.'], commands: [] },
      },
    ]) {
      const events = await runGatewayRequest({
        context: 'noop',
        cwd: tempDir,
        gateway,
      });
      const result = events.at(-1);
      assert.equal(result.type, 'result');
      assert.equal(result.success, false);
      assert.equal(
        helper.classifyProviderError('gateway', { message: result.error }).retryable,
        false
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gateway redacts auth failures', async () => {
  const secret = 'gateway-auth-secret';
  const response = await withGatewayServer(
    (_req, res) => {
      jsonResponse(res, 401, {
        error: {
          message: 'Unauthorized',
        },
      });
    },
    (baseUrl) =>
      runProviderExecutable(
        JSON.stringify({
          schemaVersion: 1,
          command: 'invoke',
          provider: 'gateway',
          context: 'Reply with ok.',
          options: {
            gateway: {
              baseUrl,
              apiKey: secret,
              model: 'openrouter/test-model',
              toolPolicy: {
                roots: [process.cwd()],
                commands: [],
              },
            },
          },
        })
      )
  );

  assert.equal(response.exitCode, 0);
  assert.equal(response.envelope.ok, true);
  assert.equal(response.envelope.result.classification.retryable, false);
  assertNoSecret(response.envelope, secret);
});

test('gateway classifies remote invalid-model 404 failures as permanent', async () => {
  const events = await withGatewayServer(
    (_req, res) => {
      jsonResponse(res, 404, {
        error: {
          message: 'No such model',
        },
      });
    },
    (baseUrl) =>
      runGatewayRequest({
        context: 'Reply with ok.',
        cwd: process.cwd(),
        gateway: {
          baseUrl,
          apiKey: 'gateway-test-key',
          model: 'openrouter/missing-model',
          toolPolicy: {
            roots: [process.cwd()],
            commands: [],
          },
        },
      })
  );

  const result = events.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.success, false);
  assert.match(result.error, /status 404: No such model/);
  assert.equal(
    helper.classifyProviderError('gateway', { message: result.error }).retryable,
    false
  );
});

test('gateway requires explicit tool policy before invoke', async () => {
  let runnerCalled = false;
  const response = await helper.runProviderExecutable(
    JSON.stringify({
      schemaVersion: 1,
      command: 'invoke',
      provider: 'gateway',
      context: 'noop',
      options: {
        gateway: {
          baseUrl: 'http://127.0.0.1:4000',
          apiKey: 'secret',
          model: 'test-model',
        },
      },
    }),
    {
      runner: () => {
        runnerCalled = true;
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          signal: null,
          durationMs: 1,
        };
      },
    }
  );

  assert.equal(response.exitCode, 2);
  assert.equal(response.envelope.ok, false);
  assert.equal(response.envelope.error.field, 'options.gateway.toolPolicy');
  assert.equal(runnerCalled, false);
});

test('gateway blocks disallowed command before execution', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-policy-'));
  const marker = path.join(tempDir, 'marker');

  try {
    let requestCount = 0;
    const events = await withGatewayServer(
      (_req, res) => {
        requestCount += 1;
        if (requestCount === 1) {
          jsonResponse(res, 200, {
            choices: [
              {
                message: {
                  content: 'Try a blocked command.',
                  tool_calls: [
                    {
                      id: 'tool-run',
                      type: 'function',
                      function: {
                        name: 'run_command',
                        arguments: JSON.stringify({
                          command: 'node',
                          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
                          cwd: '.',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          });
          return;
        }
        throw new Error('gateway should stop after the rejected command');
      },
      (baseUrl) =>
        runGatewayRequest({
          context: 'noop',
          cwd: tempDir,
          gateway: {
            baseUrl,
            apiKey: 'secret',
            model: 'openrouter/test-model',
            toolPolicy: {
              roots: ['.'],
              commands: [],
            },
          },
        })
    );

    const result = events.at(-1);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(requestCount, 1);
    assert.deepEqual(
      events.map((event) => event.type),
      ['text', 'tool_call', 'tool_result', 'result']
    );
    assert.equal(events.find((event) => event.type === 'tool_result')?.isError, true);
    assert.equal(result.type, 'result');
    assert.equal(result.success, false);
    assert.equal(
      helper.classifyProviderError('gateway', { message: result.error }).retryable,
      false
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gateway stops remaining tool calls in a batch after the first tool error', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-batch-stop-'));
  const marker = path.join(tempDir, 'marker.txt');

  try {
    let requestCount = 0;
    const events = await withGatewayServer((_req, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        jsonResponse(res, 200, {
          choices: [
            {
              message: {
                content: 'Run the blocked command, then patch the file.',
                tool_calls: [
                  {
                    id: 'tool-run',
                    type: 'function',
                    function: {
                      name: 'run_command',
                      arguments: JSON.stringify({
                        command: 'node',
                        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
                        cwd: '.',
                      }),
                    },
                  },
                  {
                    id: 'tool-write',
                    type: 'function',
                    function: {
                      name: 'apply_patch',
                      arguments: JSON.stringify({
                        path: 'marker.txt',
                        content: 'should-not-exist\n',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
        return;
      }
      throw new Error('gateway should stop after the first tool error in a batch');
    }, (baseUrl) =>
      runGatewayRequest({
        context: 'noop',
        cwd: tempDir,
        gateway: {
          baseUrl,
          apiKey: 'secret',
          model: 'openrouter/test-model',
          toolPolicy: {
            roots: ['.'],
            commands: [],
          },
        },
      })
    );

    assert.equal(requestCount, 1);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(
      events.map((event) => event.type),
      ['text', 'tool_call', 'tool_result', 'result']
    );
    const toolCalls = events.filter((event) => event.type === 'tool_call');
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].toolId, 'tool-run');
    assert.equal(events.at(-1).success, false);
    assert.match(events.at(-1).error, /cannot verify completion/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gateway preserves prior normalized events when a later gateway request fails', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-midrun-failure-'));
  const targetFile = path.join(tempDir, 'note.txt');
  fs.writeFileSync(targetFile, 'before\n', 'utf8');

  try {
    let requestCount = 0;
    const events = await withGatewayServer((_req, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        jsonResponse(res, 200, {
          choices: [
            {
              message: {
                content: 'Read the file first.',
                tool_calls: [
                  {
                    id: 'tool-read',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: 'note.txt' }),
                    },
                  },
                ],
              },
            },
          ],
        });
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
    }, (baseUrl) =>
      runGatewayRequest({
        context: 'noop',
        cwd: tempDir,
        gateway: {
          baseUrl,
          apiKey: 'secret',
          model: 'openrouter/test-model',
          toolPolicy: {
            roots: ['.'],
            commands: [],
          },
        },
      })
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ['text', 'tool_call', 'tool_result', 'result']
    );
    assert.equal(events.at(-1).success, false);
    assert.match(events.at(-1).error, /status 500: boom/);
    assert.equal(fs.readFileSync(targetFile, 'utf8'), 'before\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gateway emits tool_result for malformed tool arguments before failing the run', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-malformed-tool-'));

  try {
    let requestCount = 0;
    const events = await withGatewayServer((_req, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        jsonResponse(res, 200, {
          choices: [
            {
              message: {
                content: 'Run the malformed tool call.',
                tool_calls: [
                  {
                    id: 'tool-read',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{"path":',
                    },
                  },
                ],
              },
            },
          ],
        });
        return;
      }
      throw new Error('gateway should stop after malformed tool arguments');
    }, (baseUrl) =>
      runGatewayRequest({
        context: 'noop',
        cwd: tempDir,
        gateway: {
          baseUrl,
          apiKey: 'secret',
          model: 'openrouter/test-model',
          toolPolicy: {
            roots: ['.'],
            commands: [],
          },
        },
      })
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ['text', 'tool_call', 'tool_result', 'result']
    );
    assert.equal(requestCount, 1);
    assert.equal(events.find((event) => event.type === 'tool_result')?.isError, true);
    assert.match(
      events.find((event) => event.type === 'tool_result').content.message,
      /malformed JSON arguments/
    );
    assert.equal(events.at(-1).success, false);
    assert.match(events.at(-1).error, /malformed JSON arguments/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gateway returns failure result after tool errors even if the model stops', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-tool-error-'));

  try {
    let requestCount = 0;
    const events = await withGatewayServer((_req, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        jsonResponse(res, 200, {
          choices: [
            {
              message: {
                content: 'Reading a missing file.',
                tool_calls: [
                  {
                    id: 'tool-read',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: 'missing.txt' }),
                    },
                  },
                ],
              },
            },
          ],
        });
        return;
      }
      jsonResponse(res, 200, {
        choices: [
          {
            message: {
              content: 'Done.',
            },
          },
        ],
      });
    }, (baseUrl) =>
      runGatewayRequest({
        context: 'noop',
        cwd: tempDir,
        gateway: {
          baseUrl,
          apiKey: 'secret',
          model: 'openrouter/test-model',
          toolPolicy: {
            roots: ['.'],
            commands: [],
          },
        },
      })
    );

    assert.equal(events.find((event) => event.type === 'tool_result')?.isError, true);
    const result = events.at(-1);
    assert.equal(result.type, 'result');
    assert.equal(result.success, false);
    assert.match(result.error, /tool failure/i);
    assert.match(result.error, /missing\.txt/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gateway apply_patch rejects malformed fields before editing files', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-apply-patch-'));
  const targetFile = path.join(tempDir, 'note.txt');
  fs.writeFileSync(targetFile, 'x\nx\n', 'utf8');

  try {
    await assert.rejects(
      executeGatewayToolCall(
        'apply_patch',
        { path: 'note.txt', content: 123 },
        { roots: [tempDir], commands: [] }
      ),
      /apply_patch\.content must be a string/
    );
    assert.equal(fs.readFileSync(targetFile, 'utf8'), 'x\nx\n');

    await assert.rejects(
      executeGatewayToolCall(
        'apply_patch',
        { path: 'note.txt', search: 'x', replace: 'y', replaceAll: 'false' },
        { roots: [tempDir], commands: [] }
      ),
      /apply_patch\.replaceAll must be a boolean/
    );
    assert.equal(fs.readFileSync(targetFile, 'utf8'), 'x\nx\n');

    await assert.rejects(
      executeGatewayToolCall(
        'apply_patch',
        { path: 'note.txt', search: '', replace: 'y' },
        { roots: [tempDir], commands: [] }
      ),
      /apply_patch\.search must be a non-empty string/
    );
    assert.equal(fs.readFileSync(targetFile, 'utf8'), 'x\nx\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gateway rejects symlink escapes for file writes and command cwd', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-symlink-'));
  const rootDir = path.join(tempDir, 'root');
  const outsideDir = path.join(tempDir, 'outside');
  const outsideFile = path.join(outsideDir, 'outside.txt');
  const outsideWrite = path.join(outsideDir, 'written.txt');
  const outsideMarker = path.join(outsideDir, 'marker.txt');
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(outsideFile, 'outside\n', 'utf8');
  fs.symlinkSync(outsideFile, path.join(rootDir, 'link.txt'));
  fs.symlinkSync(outsideDir, path.join(rootDir, 'linkdir'));

  try {
    await assert.rejects(
      executeGatewayToolCall(
        'read_file',
        { path: 'link.txt' },
        { roots: [rootDir], commands: [] }
      ),
      /toolPolicy\.roots/
    );

    await assert.rejects(
      executeGatewayToolCall(
        'apply_patch',
        { path: 'linkdir/written.txt', content: 'escaped\n' },
        { roots: [rootDir], commands: [] }
      ),
      /toolPolicy\.roots/
    );

    await assert.rejects(
      executeGatewayToolCall(
        'run_command',
        {
          command: process.execPath,
          args: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(outsideMarker)}, 'x', 'utf8')`,
          ],
          cwd: 'linkdir',
        },
        { roots: [rootDir], commands: [process.execPath] }
      ),
      /toolPolicy\.roots/
    );

    assert.equal(fs.existsSync(outsideWrite), false);
    assert.equal(fs.existsSync(outsideMarker), false);
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gateway resolves relative tool paths against later allowlisted roots when needed', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-multi-root-'));
  const firstRoot = path.join(tempDir, 'first');
  const secondRoot = path.join(tempDir, 'second');
  const secondSubdir = path.join(secondRoot, 'subdir');
  const targetFile = path.join(secondRoot, 'file.txt');
  const markerFile = path.join(secondSubdir, 'marker.txt');
  fs.mkdirSync(firstRoot, { recursive: true });
  fs.mkdirSync(secondSubdir, { recursive: true });
  fs.writeFileSync(targetFile, 'before\n', 'utf8');

  try {
    const readResult = await executeGatewayToolCall(
      'read_file',
      { path: 'file.txt' },
      { roots: [firstRoot, secondRoot], commands: [] }
    );
    assert.equal(readResult.isError, false);
    assert.equal(fs.realpathSync(readResult.content.path), fs.realpathSync(targetFile));
    assert.equal(readResult.content.content, 'before\n');

    const patchResult = await executeGatewayToolCall(
      'apply_patch',
      { path: 'file.txt', search: 'before\n', replace: 'after\n' },
      { roots: [firstRoot, secondRoot], commands: [] }
    );
    assert.equal(patchResult.isError, false);
    assert.equal(fs.readFileSync(targetFile, 'utf8'), 'after\n');
    assert.equal(fs.realpathSync(patchResult.content.path), fs.realpathSync(targetFile));

    const commandResult = await executeGatewayToolCall(
      'run_command',
      {
        command: process.execPath,
        args: ['-e', "require('node:fs').writeFileSync('marker.txt', 'ok\\n', 'utf8')"],
        cwd: 'subdir',
      },
      { roots: [firstRoot, secondRoot], commands: [process.execPath] }
    );
    assert.equal(commandResult.isError, false);
    assert.equal(fs.realpathSync(commandResult.content.cwd), fs.realpathSync(secondSubdir));
    assert.equal(fs.readFileSync(markerFile, 'utf8'), 'ok\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gateway run_command without cwd executes once in the first allowlisted root', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-multi-root-command-'));
  const firstRoot = path.join(tempDir, 'first');
  const secondRoot = path.join(tempDir, 'second');
  const sharedLog = path.join(tempDir, 'shared.log');
  const targetFile = path.join(secondRoot, 'note.txt');
  fs.mkdirSync(firstRoot, { recursive: true });
  fs.mkdirSync(secondRoot, { recursive: true });
  fs.writeFileSync(targetFile, 'from-second-root\n', 'utf8');

  try {
    const commandResult = await executeGatewayToolCall(
      'run_command',
      {
        command: process.execPath,
        args: [
          '-e',
          `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(sharedLog)},'x');process.stdout.write(fs.readFileSync('note.txt','utf8'))`,
        ],
      },
      { roots: [firstRoot, secondRoot], commands: [process.execPath] }
    );
    assert.equal(commandResult.isError, true);
    assert.equal(fs.realpathSync(commandResult.content.cwd), fs.realpathSync(firstRoot));
    assert.match(commandResult.content.stderr, /note\.txt/);
    assert.equal(fs.readFileSync(sharedLog, 'utf8'), 'x');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gateway run_command rejects malformed args before execution', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gateway-run-command-'));
  const targetFile = path.join(tempDir, 'ran.txt');

  try {
    await assert.rejects(
      executeGatewayToolCall(
        'run_command',
        { command: 'node', args: '-e', cwd: '.' },
        { roots: [tempDir], commands: ['node'] }
      ),
      /run_command\.args must be an array/
    );

    await assert.rejects(
      executeGatewayToolCall(
        'run_command',
        {
          command: process.execPath,
          args: ['-e', `require('fs').writeFileSync(${JSON.stringify(targetFile)},'ok')`],
          cwd: 123,
        },
        { roots: [tempDir], commands: [process.execPath] }
      ),
      /run_command\.cwd must be a string/
    );
    assert.equal(fs.existsSync(targetFile), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
