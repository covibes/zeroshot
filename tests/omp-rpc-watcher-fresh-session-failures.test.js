const {
  assert,
  fs,
  path,
  runWatcher,
  storeGetTask,
  zeroshotHome,
  prepareFreshCase,
} = require('./helpers/omp-rpc-watcher-session-harness');

describe('OMP RPC watcher: fresh session failures', function () {
  this.timeout(20000);

  it('marks cleanup-required instead of committing when the provider crashes mid-turn', async function () {
    const { id, partitionPath, commandSpec } = await prepareFreshCase({
      label: 'fresh-crash',
    });

    const { code } = await runWatcher({
      id,
      commandSpec,
      scenario: 'crash',
      ompSession: { kind: 'fresh', partition: { path: partitionPath } },
    });
    assert.strictEqual(code, 0);

    const task = await storeGetTask(id);
    assert.strictEqual(task.status, 'failed');
    assert.strictEqual(task.ompSessionOwnership.state, 'cleanup-required');
  });

  it('refuses to claim a session OMP wrote outside this task s partition', async function () {
    const { id, partitionPath, commandSpec } = await prepareFreshCase({
      label: 'fresh-outside-partition',
    });
    const elsewhere = path.join(zeroshotHome, `${id}-elsewhere.jsonl`);
    fs.writeFileSync(elsewhere, '{"type":"session","id":"elsewhere"}\n');

    const { code } = await runWatcher({
      id,
      commandSpec,
      scenario: 'happy',
      ompSession: { kind: 'fresh', partition: { path: partitionPath } },
      env: {
        OMP_FAKE_RPC_MINT_SESSION_ID: 'in-partition',
        OMP_FAKE_RPC_SESSION_FILE: elsewhere,
        OMP_FAKE_RPC_SESSION_ID: 'elsewhere',
      },
    });
    assert.strictEqual(code, 0);
    const task = await storeGetTask(id);
    assert.strictEqual(task.ompSessionOwnership.state, 'cleanup-required');
  });

  it('refuses a materialized header whose recorded cwd is not this task s workspace', async function () {
    const { id, partitionPath, commandSpec } = await prepareFreshCase({
      label: 'fresh-wrong-cwd',
    });

    const { code } = await runWatcher({
      id,
      commandSpec,
      scenario: 'happy',
      ompSession: { kind: 'fresh', partition: { path: partitionPath } },
      env: {
        OMP_FAKE_RPC_MINT_SESSION_ID: 'wrong-cwd-session',
        OMP_FAKE_RPC_SESSION_CWD: '/somewhere/else/entirely',
      },
    });
    assert.strictEqual(code, 0);
    const task = await storeGetTask(id);
    assert.strictEqual(task.ompSessionOwnership.state, 'cleanup-required');
  });
});
