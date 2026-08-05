const assert = require('assert');
const { Command, Option } = require('commander');
const { getCompletionCandidates } = require('../../lib/completion');

function buildProgram() {
  const program = new Command()
    .name('zeroshot')
    .helpCommand(false)
    .option('-q, --quiet', 'Suppress output');
  program.command('run <input>').alias('go').option('--docker', 'Use Docker');
  program
    .command('status <id>')
    .option('--json', 'Output JSON')
    .addOption(new Option('--internal').hideHelp());
  program.command('secret', { hidden: true });
  return program;
}

describe('Commander-backed completion', function () {
  it('derives visible commands, aliases, and options from the command tree', function () {
    const program = buildProgram();
    const root = getCompletionCandidates(program, 'zeroshot ', { listClusterIds: () => [] });

    for (const candidate of ['run', 'go', 'status', '-q', '--quiet', '-h', '--help']) {
      assert.ok(root.includes(candidate), `missing root candidate ${candidate}`);
    }
    assert.ok(!root.includes('secret'));

    const run = getCompletionCandidates(program, 'zeroshot go ', { listClusterIds: () => [] });
    assert.ok(run.includes('--docker'));
    assert.ok(run.includes('--help'));
    assert.ok(!run.includes('--quiet'));
  });

  it('uses the registry reader for dynamic cluster IDs', function () {
    const candidates = getCompletionCandidates(buildProgram(), 'zeroshot status ', {
      listClusterIds: () => ['cluster-a', 'cluster-b'],
    });

    assert.ok(candidates.includes('cluster-a'));
    assert.ok(candidates.includes('cluster-b'));
    assert.ok(candidates.includes('--json'));
    assert.ok(!candidates.includes('--internal'));
  });

  it('keeps structural candidates when the registry cannot be read safely', function () {
    const candidates = getCompletionCandidates(buildProgram(), 'zeroshot status ', {
      listClusterIds() {
        throw new Error('unreadable registry');
      },
    });

    assert.ok(candidates.includes('--json'));
    assert.ok(candidates.includes('--help'));
    assert.ok(!candidates.includes('cluster-a'));
  });
});
