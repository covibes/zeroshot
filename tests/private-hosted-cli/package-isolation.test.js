'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, it } = require('node:test');
const { COMMAND_MANIFEST, PRIVATE_MARKER } = require('../../private/hosted-cli-candidate/manifest');
const { parseArgs } = require('../../private/hosted-cli-candidate/build-candidate');

const ROOT = path.resolve(__dirname, '../..');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    ...options,
  });
}

describe('stable/candidate package isolation', () => {
  it('keeps every candidate source and marker out of normal npm pack', () => {
    const result = run('npm', [
      'pack',
      '--json',
      '--dry-run',
      '--ignore-scripts',
      '--foreground-scripts=false',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const packed = JSON.parse(result.stdout)[0];
    const paths = packed.files.map((file) => file.path);
    assert.equal(
      paths.some((file) => file.startsWith('private/')),
      false
    );
    assert.equal(
      paths.some((file) => file.startsWith('tests/private-hosted-cli/')),
      false
    );
    assert.equal(paths.includes('PRIVATE_HOSTED_CANDIDATE.txt'), false);
    assert.equal(JSON.stringify(packed).includes(PRIVATE_MARKER), false);
  });

  it('leaves the checked-in stable entrypoint without private registration', () => {
    const stable = fs.readFileSync(path.join(ROOT, 'cli/index.js'), 'utf8');
    assert.equal(stable.includes('registerPrivateHostedCandidate'), false);
    for (const command of COMMAND_MANIFEST) {
      assert.equal(stable.includes(command), false, `stable CLI leaked ${command}`);
    }
  });

  it('normal real CLI rejects hosted roots and does not reinterpret them as local run input', () => {
    for (const argv of [
      ['target', 'list'],
      ['capsule', 'create', '--target', 'prod'],
    ]) {
      const result = run(process.execPath, ['cli/index.js', ...argv], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1', CI: '1' },
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /unknown command/);
    }
  });

  it('candidate build code contains no publication or release invocation', () => {
    const builder = fs.readFileSync(
      path.join(ROOT, 'private/hosted-cli-candidate/build-candidate.js'),
      'utf8'
    );
    assert.equal(/semantic-release|npm\s+publish|git\s+tag|gh\s+release/.test(builder), false);
    assert.match(builder, /pkg\.private = true/);
    assert.match(builder, /delete pkg\.publishConfig/);
  });

  it('requires the runtime, cloud commit, and fixed hosted selection', () => {
    const runtimeImageDigest = `sha256:${'a'.repeat(64)}`;
    const zeroCloudCommit = 'b'.repeat(40);
    const parsed = parseArgs([
      '--runtime-image-digest',
      runtimeImageDigest,
      '--zero-cloud-commit',
      zeroCloudCommit,
      '--repository',
      'owner/repository',
      '--provider',
      'codex',
      '--model-level',
      'level2',
    ]);
    assert.deepEqual(parsed, {
      runtimeImageDigest,
      zeroCloudCommit,
      repository: 'owner/repository',
      provider: 'codex',
      modelLevel: 'level2',
    });
    assert.equal(Object.isFrozen(parsed), true);

    const prefix = [
      '--runtime-image-digest',
      runtimeImageDigest,
      '--zero-cloud-commit',
      zeroCloudCommit,
      '--repository',
      'owner/repository',
    ];
    assert.throws(() => parseArgs([...prefix, '--provider', 'gateway', '--model-level', 'level2']));
    assert.throws(() => parseArgs([...prefix, '--provider', 'codex', '--model-level', 'level3']));
    assert.throws(() => parseArgs(prefix), /provider/);
  });
});
