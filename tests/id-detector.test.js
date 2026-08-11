const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const detector = require('../lib/id-detector');

const HOME_ENV_KEYS = ['ZEROSHOT_HOME', 'HOME', 'USERPROFILE'];

function withDetectorHome(run) {
  const originalEnv = Object.fromEntries(HOME_ENV_KEYS.map((key) => [key, process.env[key]]));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-id-detector-'));
  process.env.ZEROSHOT_HOME = homeDir;
  process.env.HOME = path.join(homeDir, 'ignored-home');
  process.env.USERPROFILE = path.join(homeDir, 'ignored-profile');
  try {
    return run(homeDir);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function writeClusters(homeDir, data) {
  const storageDir = path.join(homeDir, '.zeroshot');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'clusters.json'), data);
}

function createTaskDatabase(homeDir, ids) {
  const taskDir = path.join(homeDir, '.claude-zeroshot');
  fs.mkdirSync(taskDir, { recursive: true });
  const databasePath = path.join(taskDir, 'store.db');
  const database = new Database(databasePath);
  database.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY)');
  const insert = database.prepare('INSERT INTO tasks (id) VALUES (?)');
  for (const id of ids) insert.run(id);
  database.close();
  return databasePath;
}

describe('ID detector cluster lookup', function () {
  it('preserves the CommonJS API contract', function () {
    assert.deepStrictEqual(Reflect.ownKeys(detector), ['detectIdType']);
    assert.strictEqual(detector.detectIdType.length, 1);
  });

  it('returns null when neither storage contains the ID', function () {
    withDetectorHome(() => {
      assert.strictEqual(detector.detectIdType('missing'), null);
    });
  });

  it('uses ZEROSHOT_HOME and detects truthy cluster entries', function () {
    withDetectorHome((homeDir) => {
      writeClusters(homeDir, JSON.stringify({ cluster: { status: 'running' }, falsy: 0 }));
      assert.strictEqual(detector.detectIdType('cluster'), 'cluster');
      assert.strictEqual(detector.detectIdType('falsy'), null);
    });
  });
});

describe('ID detector task lookup', function () {
  it('finds tasks in the legacy SQLite store', function () {
    withDetectorHome((homeDir) => {
      createTaskDatabase(homeDir, ['task-only']);
      assert.strictEqual(detector.detectIdType('task-only'), 'task');
    });
  });

  it('gives a cluster precedence over a task with the same ID', function () {
    withDetectorHome((homeDir) => {
      writeClusters(homeDir, JSON.stringify({ shared: { status: 'running' } }));
      createTaskDatabase(homeDir, ['shared']);
      assert.strictEqual(detector.detectIdType('shared'), 'cluster');
    });
  });

  it('falls through malformed cluster JSON to the task store', function () {
    withDetectorHome((homeDir) => {
      writeClusters(homeDir, '{invalid');
      createTaskDatabase(homeDir, ['task-only']);
      assert.strictEqual(detector.detectIdType('task-only'), 'task');
    });
  });

  it('ignores unreadable SQLite stores', function () {
    withDetectorHome((homeDir) => {
      const taskDir = path.join(homeDir, '.claude-zeroshot');
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, 'store.db'), 'not sqlite');
      assert.strictEqual(detector.detectIdType('task-only'), null);
    });
  });
});
