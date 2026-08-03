import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { Command } from 'commander';

const require = createRequire(resolve('tests/target/target-commands.test.ts'));
const { registerHostedCommands } = require('../../cli/register-hosted-commands.js') as {
  registerHostedCommands(program: Command, dependencies: Record<string, unknown>): Command;
};

describe('private hosted command registration boundary', () => {
  it('exports one explicit registration function without mutating a parser on import', () => {
    assert.equal(typeof registerHostedCommands, 'function');
    const untouched = new Command();
    assert.equal(untouched.commands.length, 0);
  });

  it('registers hosted syntax only when the private candidate calls the boundary', () => {
    const program = new Command();
    const target = registerHostedCommands(program, {
      chalk: {
        red: String,
        green: String,
        dim: String,
        bold: String,
      },
      loadSettings: () => ({}),
      mutateSettings: () => undefined,
      console: { log: () => undefined, error: () => undefined },
      stderr: { write: () => undefined },
      fetch: () => {
        throw new Error('network must not run during registration');
      },
      setExitCode: () => undefined,
    });
    assert.equal(program.commands.map((command) => command.name()).includes('target'), true);
    assert.deepEqual(
      target.commands.map((command) => command.name()),
      ['add', 'login', 'list', 'remove']
    );
  });

  it('rejects an invalid descriptor before settings mutation', async () => {
    let mutations = 0;
    let networkCalls = 0;
    const errors: string[] = [];
    const program = new Command();
    registerHostedCommands(program, {
      chalk: {
        red: String,
        green: String,
        dim: String,
        bold: String,
      },
      loadSettings: () => ({}),
      mutateSettings: () => {
        mutations += 1;
      },
      console: {
        log: () => undefined,
        error: (message: string) => {
          errors.push(message);
        },
      },
      stderr: { write: () => undefined },
      fetch: async () => {
        networkCalls += 1;
        return new Response('{}', { status: 200 });
      },
      setExitCode: () => undefined,
    });

    await program.parseAsync([
      'node',
      'test',
      'target',
      'add',
      'unsafe',
      '--url',
      'https://hosted.example',
    ]);

    assert.equal(networkCalls, 1);
    assert.equal(mutations, 0);
    assert.equal(errors.length, 1);
  });

  it('force-removes an offline target and still clears local credentials', async () => {
    const state = {
      _targets: {
        primary: {
          id: 'target-1',
          url: 'https://hosted.example',
          adapterVersion: 'v1',
          deviceToken: 'device-token',
          createdAt: '2026-08-03T00:00:00Z',
        },
      },
    };
    let deletes = 0;
    const logs: string[] = [];
    const program = new Command();
    registerHostedCommands(program, {
      chalk: {
        red: String,
        green: String,
        dim: String,
        bold: String,
      },
      loadSettings: () => state,
      mutateSettings: (mutation: (settings: typeof state) => void) => mutation(state),
      console: {
        log: (message: string) => logs.push(message),
        error: assert.fail,
      },
      stderr: { write: () => undefined },
      fetch: async () => {
        throw new Error('target offline');
      },
      createCredentialStore: async () => ({
        get: async () => null,
        set: async () => undefined,
        delete: async () => {
          deletes += 1;
        },
      }),
      acquireTargetLock: async () => async () => undefined,
      setExitCode: assert.fail,
    });

    await program.parseAsync([
      'node',
      'test',
      'target',
      'remove',
      'primary',
      '--force',
    ]);

    assert.equal(state._targets.primary, undefined);
    assert.equal(deletes, 1);
    assert.deepEqual(logs, ['Target \"primary\" removed']);
  });
});
