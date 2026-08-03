'use strict';

const assert = require('node:assert/strict');
const { Command } = require('commander');
const { afterEach, describe, it } = require('node:test');
const { COMMAND_MANIFEST } = require('../../private/hosted-cli-candidate/manifest');
const { registerPrivateHostedCandidate } = require('../../private/hosted-cli-candidate/register');

function harness() {
  const calls = [];
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  program
    .command('run <input>')
    .option('--docker')
    .option('-d, --detach')
    .action((input, options) => {
      calls.push(['local-run', input, options.detach]);
    });
  program
    .command('list')
    .alias('ls')
    .option('-s, --status <status>')
    .option('-n, --limit <n>', '', Number)
    .option('--json')
    .action((options) => {
      calls.push(['local-list', options]);
    });
  program
    .command('status <id>')
    .option('--json')
    .action((id) => calls.push(['local-status', id]));
  program.command('stop <id>').action((id) => calls.push(['local-stop', id]));
  program.command('logs [id]').action((id) => calls.push(['local-logs', id]));
  const serviceNames = [
    'targetAdd',
    'targetLogin',
    'targetList',
    'targetRemove',
    'targetSetup',
    'capsuleCreate',
    'capsuleTerminate',
    'remoteRun',
    'remoteList',
    'remoteStatus',
    'remoteStop',
  ];
  const services = Object.fromEntries(
    serviceNames.map((name) => [name, (...args) => calls.push([name, ...args])])
  );
  let settingsReads = 0;
  registerPrivateHostedCandidate(program, {
    loadSettings: () => {
      settingsReads += 1;
      return {};
    },
    mutateSettings: () => undefined,
    services,
  });
  return { program, calls, settingsReads: () => settingsReads };
}

async function parse(program, argv) {
  await program.parseAsync(['node', 'zeroshot', ...argv]);
}

afterEach(() => {
  process.exitCode = 0;
});

describe('private candidate closed parser', () => {
  it('publishes exactly the frozen private command manifest', () => {
    const { program } = harness();
    assert.deepEqual(program.privateHostedCommandManifest, COMMAND_MANIFEST);
    assert.equal(COMMAND_MANIFEST.length, 11);
  });

  it('preserves stable handlers and never reads hosted settings without --target', async () => {
    const { program, calls, settingsReads } = harness();
    await parse(program, ['run', 'local-task', '-d']);
    await parse(program, ['list', '--json']);
    await parse(program, ['status', 'local-id']);
    await parse(program, ['stop', 'local-id']);
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['local-run', 'local-list', 'local-status', 'local-stop']
    );
    assert.equal(settingsReads(), 0);
  });

  it('rejects incompatible hosted run syntax before action side effects', async () => {
    const { program, calls, settingsReads } = harness();
    await parse(program, [
      'run',
      '--target',
      'prod',
      '--graph',
      'g.json',
      '--input',
      'i.json',
      '--docker',
    ]);
    assert.deepEqual(calls, []);
    assert.equal(settingsReads(), 0);
    assert.equal(process.exitCode, 1);
  });

  it('rejects general text run with a target and does not fall back locally', async () => {
    const { program, calls } = harness();
    await parse(program, [
      'run',
      'text',
      '--target',
      'prod',
      '--graph',
      'g.json',
      '--input',
      'i.json',
    ]);
    assert.deepEqual(calls, []);
    assert.equal(process.exitCode, 1);
  });

  it('rejects explicit empty targets and the ls hosted alias without local fallback', async () => {
    for (const argv of [
      ['run', 'local-task', '--target', ''],
      ['list', '--target', ''],
      ['status', 'cap-1', '--target', ''],
      ['stop', 'cap-1', '--target', ''],
      ['ls', '--target', 'prod'],
    ]) {
      const { program, calls, settingsReads } = harness();
      await parse(program, argv);
      assert.deepEqual(calls, []);
      assert.equal(settingsReads(), 0);
      assert.equal(process.exitCode, 1);
      process.exitCode = 0;
    }
  });

  it('dispatches each remote lifecycle route without conflating stop and terminate', async () => {
    const { program, calls } = harness();
    await parse(program, [
      'run',
      '--target',
      'prod',
      '--graph',
      'g.json',
      '--input',
      'i.json',
      '-d',
    ]);
    await parse(program, ['list', '--target', 'prod', '--limit', '7', '--json']);
    await parse(program, ['status', 'cap-1', '--target', 'prod', '--json']);
    await parse(program, ['stop', 'cap-1', '--target', 'prod', '--force']);
    await parse(program, ['capsule', 'terminate', 'cap-1', '--target', 'prod']);
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['remoteRun', 'remoteList', 'remoteStatus', 'remoteStop', 'capsuleTerminate']
    );
    assert.equal(calls[3][2].force, true);
  });

  it('exposes target setup without any secret-valued option', () => {
    const { program } = harness();
    const target = program.commands.find((command) => command.name() === 'target');
    const setup = target.commands.find((command) => command.name() === 'setup');
    assert.deepEqual(
      setup.options.map((option) => option.long),
      ['--repository', '--provider']
    );
    assert.equal(
      process.argv.some((arg) => /token|api-key|secret/i.test(arg)),
      false
    );
  });

  it('keeps remote logs and all-targets outside the candidate grammar', async () => {
    const { program, calls } = harness();
    await assert.rejects(parse(program, ['logs', 'cap-1', '--target', 'prod']), /unknown option/);
    await assert.rejects(parse(program, ['list', '--all-targets']), /unknown option/);
    assert.deepEqual(calls, []);
  });
});
