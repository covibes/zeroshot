const assert = require('assert');
const fs = require('fs');
const path = require('path');

const socketPaths = require('../../src/attach/socket-paths');

describe('attach socket paths', function () {
  const createdDirs = new Set();

  afterEach(() => {
    for (const socketDir of createdDirs) {
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
    createdDirs.clear();
  });

  function taskPath(taskId, homeDir) {
    const socketPath = socketPaths.getTaskSocketPath(taskId, homeDir);
    createdDirs.add(path.dirname(socketPath));
    return socketPath;
  }

  it('allocates deterministic short paths isolated by Zeroshot home', function () {
    const longHome = path.join('/tmp', 'long-home-segment-'.repeat(20));
    const first = taskPath('sparkling-fortress-99', longHome);
    const repeated = taskPath('sparkling-fortress-99', longHome);
    const otherHome = taskPath('sparkling-fortress-99', `${longHome}-other`);

    assert.strictEqual(first, repeated);
    assert.notStrictEqual(first, otherHome);
    assert(Buffer.byteLength(first) < 100, `socket path is too long: ${first}`);
    assert(!first.includes(longHome));
  });

  it('resolves Zeroshot home before generic process home variables', function () {
    const sharedHome = '/tmp/shared-home';
    const first = socketPaths.resolveHomeDir({
      ZEROSHOT_HOME: '/tmp/zeroshot-home-a',
      HOME: sharedHome,
      USERPROFILE: sharedHome,
    });
    const second = socketPaths.resolveHomeDir({
      ZEROSHOT_HOME: '/tmp/zeroshot-home-b',
      HOME: sharedHome,
      USERPROFILE: sharedHome,
    });

    assert.strictEqual(first, '/tmp/zeroshot-home-a');
    assert.strictEqual(second, '/tmp/zeroshot-home-b');
    assert.strictEqual(
      socketPaths.resolveHomeDir({ HOME: sharedHome, USERPROFILE: '/tmp/profile-home' }),
      sharedHome
    );
    assert.strictEqual(
      socketPaths.resolveHomeDir({ USERPROFILE: '/tmp/profile-home' }),
      '/tmp/profile-home'
    );
    assert.notStrictEqual(socketPaths.getSocketDir(first), socketPaths.getSocketDir(second));
  });

  it('protects each per-user socket directory with owner-only permissions', function () {
    if (process.platform === 'win32') this.skip();

    const socketPath = taskPath('secure-task', '/tmp/zeroshot-secure-home');
    const mode = fs.statSync(path.dirname(socketPath)).mode & 0o777;

    assert.strictEqual(mode, 0o700);
  });

  it('repairs permissive agent socket subdirectory permissions', function () {
    if (process.platform === 'win32') this.skip();

    const homeDir = '/tmp/zeroshot-agent-permission-home';
    const socketDir = socketPaths.ensureSocketDir(homeDir);
    const clusterDir = path.join(socketDir, 'permission-cluster');
    createdDirs.add(socketDir);
    fs.mkdirSync(clusterDir, { mode: 0o755 });
    fs.chmodSync(clusterDir, 0o755);

    socketPaths.getAgentSocketPath('permission-cluster', 'worker', homeDir);

    assert.strictEqual(fs.statSync(clusterDir).mode & 0o777, 0o700);
  });

  it('rejects symlinked agent socket subdirectories', function () {
    if (process.platform === 'win32') this.skip();

    const homeDir = '/tmp/zeroshot-agent-symlink-home';
    const socketDir = socketPaths.ensureSocketDir(homeDir);
    const targetDir = fs.mkdtempSync('/tmp/zeroshot-agent-target-');
    const clusterDir = path.join(socketDir, 'symlink-cluster');
    createdDirs.add(socketDir);
    createdDirs.add(targetDir);
    fs.symlinkSync(targetDir, clusterDir);

    assert.throws(
      () => socketPaths.getAgentSocketPath('symlink-cluster', 'worker', homeDir),
      /not a directory|symbolic link/
    );
  });
});
