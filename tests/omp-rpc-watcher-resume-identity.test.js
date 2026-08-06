const { runEchoCase } = require('./helpers/omp-rpc-watcher-session-harness');

describe('OMP RPC watcher: exact echoed resume identity', function () {
  this.timeout(20000);

  it('refuses when get_state omits the session id entirely', async function () {
    await runEchoCase({
      label: 'omit-id',
      env: () => ({ OMP_FAKE_RPC_OMIT_SESSION_ID: '1' }),
      errorPattern: /reported no sessionId/,
    });
  });

  it('refuses when get_state omits the session file entirely', async function () {
    await runEchoCase({
      label: 'omit-file',
      env: () => ({ OMP_FAKE_RPC_OMIT_SESSION_FILE: '1' }),
      errorPattern: /reported no sessionFile/,
    });
  });

  it('refuses when get_state omits both, rather than trusting the partition on disk', async function () {
    await runEchoCase({
      label: 'omit-both',
      env: () => ({
        OMP_FAKE_RPC_OMIT_SESSION_ID: '1',
        OMP_FAKE_RPC_OMIT_SESSION_FILE: '1',
      }),
      errorPattern: /reported no session(Id|File)/,
    });
  });

  it('refuses a session id that is only a PREFIX of the recorded one', async function () {
    await runEchoCase({
      label: 'prefix-id',
      env: ({ partition }) => ({
        OMP_FAKE_RPC_SESSION_ID: partition.sessionId.slice(0, -3),
      }),
      errorPattern: /echoed sessionId/,
    });
  });

  it("refuses a session file that is another partition's transcript", async function () {
    await runEchoCase({
      label: 'wrong-file',
      decoyPartition: true,
      env: ({ other }) => ({ OMP_FAKE_RPC_SESSION_FILE: other.sessionFilePath }),
      errorPattern: /echoed sessionFile/,
    });
  });
});
