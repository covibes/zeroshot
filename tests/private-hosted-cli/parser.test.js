'use strict';

const assert = require('node:assert/strict');
const { Command } = require('commander');
const { afterEach, describe, it } = require('node:test');
const { COMMAND_MANIFEST } = require('../../private/hosted-cli-candidate/manifest');
const { registerPrivateHostedCandidate } = require('../../private/hosted-cli-candidate/register');

function harness() {
  const calls = [];
  const program = new Command();
  program.option('--quiet');
  program.exitOverride().configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  program
    .command('run <input>')
    .option('--docker')
    .option('--pr')
    .option('--ship')
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
    'remoteQueueRun',
    'remoteList',
    'remoteStatus',
    'remoteStop',
    'runIntentStatus',
    'runIntentCancel',
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

function hostedRun(...options) {
  return ['run', '--target', 'prod', '--graph', 'g.json', '--input', 'i.json', ...options];
}

afterEach(() => {
  process.exitCode = 0;
});

function assertsFrozenPrivateCommandManifest() {
  const { program } = harness();
  assert.deepEqual(program.privateHostedCommandManifest, COMMAND_MANIFEST);
  assert.equal(COMMAND_MANIFEST.length, 13);
}

async function preservesStableHandlersWithoutHostedSettings() {
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
}

async function rejectsIncompatibleHostedRunSyntax() {
  const { program, calls, settingsReads } = harness();
  await parse(program, hostedRun('--pr', '--docker'));
  assert.deepEqual(calls, []);
  assert.equal(settingsReads(), 0);
  assert.equal(process.exitCode, 1);
}

async function rejectsGeneralTextRunWithTarget() {
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
    '--pr',
  ]);
  assert.deepEqual(calls, []);
  assert.equal(process.exitCode, 1);
}

async function keepsDirectRunDefaultAndQueueRecoverySyntax() {
  const direct = harness();
  await parse(direct.program, hostedRun('--pr'));
  assert.deepEqual(
    direct.calls.map((call) => call[0]),
    ['remoteRun']
  );

  const queued = harness();
  await parse(
    queued.program,
    hostedRun('--queue', '--ship', '--submission-key', '019fd17d-d9a7-4ef7-8a62-4e46f907c8ec')
  );
  assert.deepEqual(
    queued.calls.map((call) => call[0]),
    ['remoteQueueRun']
  );

  for (const argv of [
    ['run', 'local-task', '--queue'],
    hostedRun('--submission-key', '019fd17d-d9a7-4ef7-8a62-4e46f907c8ec'),
  ]) {
    const rejected = harness();
    await parse(rejected.program, argv);
    assert.deepEqual(rejected.calls, []);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  }

  const invalidKey = harness();
  await assert.rejects(
    parse(invalidKey.program, hostedRun('--queue', '--submission-key', 'not-a-uuid')),
    /canonical UUID/
  );
  assert.deepEqual(invalidKey.calls, []);
}

async function rejectsEmptyTargetsAndHostedLsAliases() {
  for (const argv of [
    ['run', 'local-task', '--target', ''],
    ['list', '--target', ''],
    ['status', 'cap-1', '--target', ''],
    ['stop', 'cap-1', '--target', ''],
    ['ls', '--target', 'prod'],
    ['--quiet', 'ls', '--target', 'prod'],
  ]) {
    const { program, calls, settingsReads } = harness();
    await parse(program, argv);
    assert.deepEqual(calls, []);
    assert.equal(settingsReads(), 0);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  }
}

async function preservesLocalLsAliasAfterGlobalOption() {
  const { program, calls, settingsReads } = harness();
  await parse(program, ['--quiet', 'ls', '--json']);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['local-list']
  );
  assert.equal(settingsReads(), 0);
  assert.equal(process.exitCode, 0);
}

async function dispatchesRemoteLifecycleRoutes() {
  const { program, calls } = harness();
  await parse(program, hostedRun('--pr', '-d'));
  await parse(program, ['list', '--target', 'prod', '--limit', '7', '--json']);
  await parse(program, ['status', 'cap-1', '--target', 'prod', '--json']);
  await parse(program, ['stop', 'cap-1', '--target', 'prod', '--force']);
  await parse(program, ['capsule', 'terminate', 'cap-1', '--target', 'prod']);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['remoteRun', 'remoteList', 'remoteStatus', 'remoteStop', 'capsuleTerminate']
  );
  assert.equal(calls[3][2].force, true);
}

async function exposesPrivateTargetRunIntentRoutes() {
  const { program, calls } = harness();
  await parse(program, [
    'target',
    'status',
    'prod',
    '019fd17e-11a9-7f05-8e44-6ae3b08a335f',
    '--follow',
  ]);
  await parse(program, ['target', 'cancel', 'prod', '019fd17e-11a9-7f05-8e44-6ae3b08a335f']);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['runIntentStatus', 'runIntentCancel']
  );
  assert.equal(calls[0][3].follow, true);
}

function exposesTargetSetupWithoutSecretOption() {
  const { program } = harness();
  const target = program.commands.find((command) => command.name() === 'target');
  const setup = target.commands.find((command) => command.name() === 'setup');
  assert.deepEqual(
    setup.options.map((option) => option.long),
    ['--repository', '--base', '--target-branch', '--runtime-config']
  );
  assert.equal(
    process.argv.some((arg) => /token|api-key|secret/i.test(arg)),
    false
  );
}

async function keepsRemoteLogsAndAllTargetsOutsideGrammar() {
  const { program, calls } = harness();
  await assert.rejects(parse(program, ['logs', 'cap-1', '--target', 'prod']), /unknown option/);
  await assert.rejects(parse(program, ['list', '--all-targets']), /unknown option/);
  assert.deepEqual(calls, []);
}
function registerPrivateCandidateParserTests() {
  const cases = [
    ['publishes the frozen private command manifest', assertsFrozenPrivateCommandManifest],
    [
      'preserves stable handlers without hosted settings',
      preservesStableHandlersWithoutHostedSettings,
    ],
    ['rejects incompatible hosted run syntax', rejectsIncompatibleHostedRunSyntax],
    ['rejects general text run with a target', rejectsGeneralTextRunWithTarget],
    ['keeps direct run and queue recovery syntax', keepsDirectRunDefaultAndQueueRecoverySyntax],
    ['rejects empty targets and hosted ls aliases', rejectsEmptyTargetsAndHostedLsAliases],
    ['preserves local ls after a global option', preservesLocalLsAliasAfterGlobalOption],
    ['dispatches distinct remote lifecycle routes', dispatchesRemoteLifecycleRoutes],
    ['exposes private RunIntent target routes', exposesPrivateTargetRunIntentRoutes],
    ['exposes target setup without secret options', exposesTargetSetupWithoutSecretOption],
    ['keeps remote logs and all-targets unsupported', keepsRemoteLogsAndAllTargetsOutsideGrammar],
  ];
  for (const [name, test] of cases) it(name, test);
}
describe('private candidate closed parser', registerPrivateCandidateParserTests);
