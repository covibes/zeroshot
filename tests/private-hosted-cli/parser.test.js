'use strict';

const assert = require('node:assert/strict');
const { Command } = require('commander');
const { afterEach, describe, it } = require('node:test');
const { COMMAND_MANIFEST } = require('../../private/hosted-cli-candidate/manifest');
const { registerPrivateHostedCandidate } = require('../../private/hosted-cli-candidate/register');

const RUN_TITLE = 'Review checkout flow';

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
    .option('--config <file>')
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
  program
    .command('attach [id]')
    .option('--agent <name>')
    .action((id) => calls.push(['local-attach', id]));
  const serviceNames = [
    'targetAdd',
    'targetLogin',
    'targetList',
    'targetRemove',
    'targetSetup',
    'capsuleCreate',
    'capsuleTerminate',
    'remoteRun',
    'remoteAttach',
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
  return [
    'run',
    '--target',
    'prod',
    '--graph',
    'g.json',
    '--input',
    'i.json',
    '--title',
    RUN_TITLE,
    ...options,
  ];
}

afterEach(() => {
  process.exitCode = 0;
});

function assertsFrozenPrivateCommandManifest() {
  const { program } = harness();
  assert.deepEqual(program.privateHostedCommandManifest, COMMAND_MANIFEST);
  assert.equal(COMMAND_MANIFEST.length, 14);
}

async function preservesStableHandlersWithoutHostedSettings() {
  const { program, calls, settingsReads } = harness();
  await parse(program, ['run', 'local-task', '-d']);
  await parse(program, ['list', '--json']);
  await parse(program, ['status', 'local-id']);
  await parse(program, ['stop', 'local-id']);
  await parse(program, ['attach', 'local-id']);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['local-run', 'local-list', 'local-status', 'local-stop', 'local-attach']
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
    '--title',
    RUN_TITLE,
    '--pr',
  ]);
  assert.deepEqual(calls, []);
  assert.equal(process.exitCode, 1);
}

async function requiresBoundedHostedRunTitles() {
  for (const argv of [
    ['run', '--target', 'prod', '--graph', 'g.json', '--input', 'i.json', '--ship'],
    hostedRun('--title', '', '--ship'),
    hostedRun('--title', '🚀'.repeat(101), '--ship'),
    ['run', 'local-task', '--title', RUN_TITLE],
  ]) {
    const rejected = harness();
    await parse(rejected.program, argv);
    assert.deepEqual(rejected.calls, []);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  }

  const accepted = harness();
  const title = '🚀'.repeat(100);
  await parse(accepted.program, hostedRun('--title', title, '--ship'));
  assert.equal(accepted.calls[0][0], 'remoteRun');
  assert.equal(accepted.calls[0][1].title, title);
}

async function usesOnlyRunIntentAndKeepsRecoverySyntax() {
  const runIntent = harness();
  await parse(
    runIntent.program,
    hostedRun('--pr', '--submission-key', '019fd17d-d9a7-4ef7-8a62-4e46f907c8ec')
  );
  assert.deepEqual(
    runIntent.calls.map((call) => call[0]),
    ['remoteRun']
  );

  for (const argv of [['run', 'local-task', '--queue'], hostedRun('--queue', '--ship')]) {
    const rejected = harness();
    await assert.rejects(parse(rejected.program, argv), /unknown option/);
    assert.deepEqual(rejected.calls, []);
  }

  const invalidKey = harness();
  await assert.rejects(
    parse(invalidKey.program, hostedRun('--ship', '--submission-key', 'not-a-uuid')),
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
  await parse(program, hostedRun('--pr', '--config', 'cluster.json', '-d'));
  await parse(program, ['list', '--target', 'prod', '--limit', '7', '--json']);
  await parse(program, ['status', 'cap-1', '--target', 'prod', '--json']);
  await parse(program, ['stop', 'cap-1', '--target', 'prod', '--force']);
  await parse(program, ['capsule', 'terminate', 'cap-1', '--target', 'prod']);
  await parse(program, ['attach', '019fd17e-11a9-7f05-8e44-6ae3b08a335f', '--target', 'prod']);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['remoteRun', 'remoteList', 'remoteStatus', 'remoteStop', 'capsuleTerminate', 'remoteAttach']
  );
  assert.equal(calls[3][2].force, true);
  assert.equal(calls[0][1].config, 'cluster.json');
  assert.equal(calls[0][1].title, RUN_TITLE);
}

async function exposesPrivateTargetRunIntentRoutes() {
  const { program, calls } = harness();
  await parse(program, ['target', 'status', 'prod', '019fd17e-11a9-7f05-8e44-6ae3b08a335f']);
  await parse(program, ['target', 'cancel', 'prod', '019fd17e-11a9-7f05-8e44-6ae3b08a335f']);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['runIntentStatus', 'runIntentCancel']
  );
  assert.equal(calls[0][3].json, undefined);
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
    ['requires bounded hosted run titles', requiresBoundedHostedRunTitles],
    ['uses only RunIntent and keeps recovery syntax', usesOnlyRunIntentAndKeepsRecoverySyntax],
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
