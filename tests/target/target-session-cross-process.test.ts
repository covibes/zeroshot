import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

const execute = promisify(execFile);
const WORKER = resolve('tests/target/fixtures/refresh-race-worker.cjs');

describe('TargetSessionManager cross-process refresh family', () => {
  it('serializes different audiences onto one rotating refresh lineage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zeroshot-target-race-'));
    const home = join(directory, 'home');
    const targetId = 'target-race-920';
    await writeFile(join(directory, 'refresh-token'), 'old-refresh', { mode: 0o600 });
    try {
      const environment = { ...process.env, HOME: home };
      const [admin, capsule] = await Promise.all([
        execute(process.execPath, [WORKER, directory, targetId, 'admin'], { env: environment }),
        execute(process.execPath, [WORKER, directory, targetId, 'capsule'], { env: environment }),
      ]);

      assert.deepEqual(
        new Set([admin.stdout, capsule.stdout]),
        new Set(['access-admin', 'access-capsule'])
      );
      const exchanges = (await readFile(join(directory, 'exchanges'), 'utf8')).trim().split('\n');
      assert.equal(exchanges.length, 2);
      const [firstAudience, firstRefresh] = exchanges[0]!.split(':');
      const [secondAudience, secondRefresh] = exchanges[1]!.split(':');
      assert.equal(firstRefresh, 'old-refresh');
      assert.notEqual(firstAudience, secondAudience);
      assert.equal(secondRefresh, `old-refresh->${firstAudience}`);
      assert.equal(
        await readFile(join(directory, 'refresh-token'), 'utf8'),
        `old-refresh->${firstAudience}->${secondAudience}`
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
