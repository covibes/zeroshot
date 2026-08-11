const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registry = require('../lib/clusters-registry');

describe('clusters registry', function () {
  it('preserves the CommonJS API contract', function () {
    assert.deepStrictEqual(Reflect.ownKeys(registry), [
      'clustersFilePath',
      'readClustersFileSync',
      'writeClustersFileAtomic',
    ]);
    assert.deepStrictEqual(
      Object.values(registry).map((value) => value.length),
      [1, 1, 2]
    );
  });

  it('returns an empty registry when clusters.json is missing', function () {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-clusters-'));
    try {
      assert.strictEqual(
        registry.clustersFilePath(storageDir),
        path.join(storageDir, 'clusters.json')
      );
      assert.deepStrictEqual(registry.readClustersFileSync(storageDir), {});
    } finally {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it('writes formatted JSON atomically and reads it back', function () {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-clusters-'));
    const data = { beta: { status: 'done' }, alpha: [1, true, null] };
    try {
      registry.writeClustersFileAtomic(storageDir, data);
      const clustersFile = path.join(storageDir, 'clusters.json');
      assert.strictEqual(fs.readFileSync(clustersFile, 'utf8'), JSON.stringify(data, null, 2));
      assert.deepStrictEqual(registry.readClustersFileSync(storageDir), data);
      assert.deepStrictEqual(
        fs.readdirSync(storageDir).filter((name) => name.includes('.tmp-')),
        []
      );
    } finally {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it('preserves JSON parse failures', function () {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-clusters-'));
    try {
      fs.writeFileSync(path.join(storageDir, 'clusters.json'), '{invalid');
      assert.throws(() => registry.readClustersFileSync(storageDir), SyntaxError);
    } finally {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
