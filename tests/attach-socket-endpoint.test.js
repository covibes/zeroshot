const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE_PATH = '../src/attach/socket-endpoint';

/** Load socket-endpoint as if running on `platform`. */
function loadFor(platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  delete require.cache[require.resolve(MODULE_PATH)];
  try {
    return require(MODULE_PATH);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    delete require.cache[require.resolve(MODULE_PATH)];
  }
}

describe('attach socket endpoint', function () {
  describe('on unix', function () {
    it('binds and connects on the record path itself', function () {
      const mod = loadFor('linux');
      const record = '/tmp/zeroshot-1000-abc/steady-spire-84.sock';
      assert.strictEqual(mod.endpointFor(record), record);
      assert.strictEqual(mod.IS_WINDOWS, false);
    });

    it('writes no record, because binding creates the socket node', function () {
      const mod = loadFor('linux');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-endpoint-'));
      const record = path.join(dir, 'task.sock');
      try {
        mod.writeEndpointRecord(record);
        assert.strictEqual(fs.existsSync(record), false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('on windows, addressing', function () {
    it('maps a record path to a named pipe in the pipe namespace', function () {
      const mod = loadFor('win32');
      const endpoint = mod.endpointFor('C:\\Users\\k\\.zeroshot\\sockets\\steady-spire-84.sock');
      assert.match(endpoint, /^\\\\\.\\pipe\\zeroshot-[0-9a-f]{32}$/);
      assert.strictEqual(mod.IS_WINDOWS, true);
    });

    it('resolves the same pipe from every process for one record', function () {
      const mod = loadFor('win32');
      const record = 'C:\\Users\\k\\.zeroshot\\sockets\\task.sock';
      assert.strictEqual(mod.endpointFor(record), mod.endpointFor(record));
    });

    it('ignores case, so two spellings of one path share a pipe', function () {
      const mod = loadFor('win32');
      assert.strictEqual(
        mod.endpointFor('C:\\Users\\K\\.zeroshot\\sockets\\Task.sock'),
        mod.endpointFor('c:\\users\\k\\.zeroshot\\sockets\\task.sock')
      );
    });

    it('separates distinct records', function () {
      const mod = loadFor('win32');
      assert.notStrictEqual(
        mod.endpointFor('C:\\s\\alpha.sock'),
        mod.endpointFor('C:\\s\\beta.sock')
      );
    });

    it('keeps the pipe name inside the namespace length limit for long records', function () {
      const mod = loadFor('win32');
      const deep = `C:\\${'nested\\'.repeat(60)}task.sock`;
      assert.ok(mod.endpointFor(deep).length < 256);
    });
  });

  describe('on windows, discovery record', function () {
    it('is a regular file that readdir-based listing still matches', function () {
      const mod = loadFor('win32');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-endpoint-'));
      const record = path.join(dir, 'steady-spire-84.sock');
      try {
        mod.writeEndpointRecord(record);

        // listAttachableTasks accepts entries that are files ending in .sock.
        const entry = fs
          .readdirSync(dir, { withFileTypes: true })
          .find((candidate) => candidate.name === 'steady-spire-84.sock');
        assert.ok(entry, 'record must appear in the socket directory');
        assert.ok(entry.isFile(), 'record must be a regular file so discovery sees it');

        // Cleanup paths unlink the record, so it has to be a removable file.
        fs.unlinkSync(record);
        assert.strictEqual(fs.existsSync(record), false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('records the pipe the server bound, for debugging a live directory', function () {
      const mod = loadFor('win32');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-endpoint-'));
      const record = path.join(dir, 'task.sock');
      try {
        mod.writeEndpointRecord(record);
        assert.strictEqual(fs.readFileSync(record, 'utf8').trim(), mod.endpointFor(record));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
