/**
 * src/omp-blob-root.js must resolve the *same* directory OMP v17.2.1's
 * `@oh-my-pi/pi-utils::getBlobsDir()` resolves (packages/utils/src/dirs.ts), because that is where
 * a resumed session's externalized payloads actually live. Getting this wrong in either direction
 * is a correctness bug: too narrow and every resume with an image fails as "blob missing"; too
 * broad and cleanup could point at a shared, machine-wide store.
 *
 * Mirrored resolution order:
 *   profile      = normalize(OMP_PROFILE ?? PI_PROFILE)
 *   configRoot   = ~/${PI_CONFIG_DIR || '.omp'}[/profiles/<profile>]
 *   agentDir     = profile ? <configRoot>/agent : (resolve(PI_CODING_AGENT_DIR) || <configRoot>/agent)
 *   dataBase     = (linux|darwin) && agentDir is the default && $XDG_DATA_HOME/omp[/profiles/<p>] exists
 *                  ? that : agentDir
 *   blobsDir     = <dataBase>/blobs
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isInsideOmpBlobsDir, resolveOmpBlobsDir } = require('../../src/omp-blob-root');

describe('src/omp-blob-root.js (getBlobsDir parity with OMP v17.2.1)', function () {
  let home;

  beforeEach(function () {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-blob-root-home-'));
  });

  function resolve(env, platform = 'linux') {
    return resolveOmpBlobsDir({ env, homedir: home, platform });
  }

  it('defaults to ~/.omp/agent/blobs', function () {
    assert.strictEqual(resolve({}), path.join(home, '.omp', 'agent', 'blobs'));
  });

  it('honours PI_CONFIG_DIR for the config root name', function () {
    assert.strictEqual(
      resolve({ PI_CONFIG_DIR: '.omp-alt' }),
      path.join(home, '.omp-alt', 'agent', 'blobs')
    );
  });

  it('honours PI_CODING_AGENT_DIR as an absolute agent-dir override', function () {
    const override = path.join(home, 'custom-agent');
    assert.strictEqual(
      resolve({ PI_CODING_AGENT_DIR: override }),
      path.join(override, 'blobs')
    );
  });

  it('resolves a relative PI_CODING_AGENT_DIR the way path.resolve does', function () {
    assert.strictEqual(
      resolve({ PI_CODING_AGENT_DIR: 'rel-agent' }),
      path.join(path.resolve('rel-agent'), 'blobs')
    );
  });

  it('pins a named profile under profiles/<name>/agent and ignores PI_CODING_AGENT_DIR there', function () {
    const expected = path.join(home, '.omp', 'profiles', 'work', 'agent', 'blobs');
    assert.strictEqual(resolve({ OMP_PROFILE: 'work' }), expected);
    assert.strictEqual(
      resolve({ OMP_PROFILE: 'work', PI_CODING_AGENT_DIR: path.join(home, 'ignored') }),
      expected,
      'a profile-derived agent dir must not be overridable (dirs.ts DirResolver)'
    );
  });

  it('prefers OMP_PROFILE over PI_PROFILE, and treats an empty OMP_PROFILE as the default', function () {
    assert.strictEqual(
      resolve({ OMP_PROFILE: 'first', PI_PROFILE: 'second' }),
      path.join(home, '.omp', 'profiles', 'first', 'agent', 'blobs')
    );
    assert.strictEqual(
      resolve({ PI_PROFILE: 'second' }),
      path.join(home, '.omp', 'profiles', 'second', 'agent', 'blobs')
    );
    assert.strictEqual(
      resolve({ OMP_PROFILE: '', PI_PROFILE: 'second' }),
      path.join(home, '.omp', 'agent', 'blobs'),
      'an explicitly empty OMP_PROFILE selects the default, not the legacy PI_PROFILE'
    );
    assert.strictEqual(
      resolve({ OMP_PROFILE: 'default' }),
      path.join(home, '.omp', 'agent', 'blobs')
    );
  });

  it('redirects to $XDG_DATA_HOME/omp/blobs only when that app root already exists', function () {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-blob-root-xdg-'));
    assert.strictEqual(
      resolve({ XDG_DATA_HOME: xdg }),
      path.join(home, '.omp', 'agent', 'blobs'),
      'no migration yet: XDG is not assumed'
    );

    fs.mkdirSync(path.join(xdg, 'omp'), { recursive: true });
    assert.strictEqual(
      resolve({ XDG_DATA_HOME: xdg }),
      path.join(xdg, 'omp', 'blobs'),
      'XDG flattens the agent/ prefix'
    );
  });

  it('keys the XDG choice on the profile-specific path for a named profile', function () {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-blob-root-xdg-profile-'));
    fs.mkdirSync(path.join(xdg, 'omp'), { recursive: true });
    assert.strictEqual(
      resolve({ XDG_DATA_HOME: xdg, OMP_PROFILE: 'work' }),
      path.join(home, '.omp', 'profiles', 'work', 'agent', 'blobs'),
      'the base app root must not decide a named profile s location'
    );

    fs.mkdirSync(path.join(xdg, 'omp', 'profiles', 'work'), { recursive: true });
    assert.strictEqual(
      resolve({ XDG_DATA_HOME: xdg, OMP_PROFILE: 'work' }),
      path.join(xdg, 'omp', 'profiles', 'work', 'blobs')
    );
  });

  it('never applies XDG when the agent dir is explicitly overridden, or off linux/darwin', function () {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-blob-root-xdg-override-'));
    fs.mkdirSync(path.join(xdg, 'omp'), { recursive: true });
    const override = path.join(home, 'explicit-agent');
    assert.strictEqual(
      resolve({ XDG_DATA_HOME: xdg, PI_CODING_AGENT_DIR: override }),
      path.join(override, 'blobs')
    );
    assert.strictEqual(
      resolve({ XDG_DATA_HOME: xdg }, 'win32'),
      path.join(home, '.omp', 'agent', 'blobs')
    );
    assert.strictEqual(
      resolve({ XDG_DATA_HOME: xdg }, 'darwin'),
      path.join(xdg, 'omp', 'blobs'),
      'darwin follows the same XDG rule as linux'
    );
  });

  it('falls back to the default profile for a syntactically invalid profile name', function () {
    for (const profile of ['..', 'UPPER', 'ends.', 'CON', 'x'.repeat(80)]) {
      assert.strictEqual(
        resolve({ OMP_PROFILE: profile }),
        path.join(home, '.omp', 'agent', 'blobs'),
        `profile ${JSON.stringify(profile)} is not a valid OMP profile`
      );
    }
  });

  it('isInsideOmpBlobsDir guards the root itself and everything under it', function () {
    const override = path.join(home, 'guarded-agent');
    const env = { PI_CODING_AGENT_DIR: override };
    const options = { env, homedir: home, platform: 'linux' };
    const blobsDir = path.join(override, 'blobs');

    assert.ok(isInsideOmpBlobsDir(blobsDir, options));
    assert.ok(isInsideOmpBlobsDir(path.join(blobsDir, 'deadbeef'), options));
    assert.ok(isInsideOmpBlobsDir(path.join(blobsDir, 'nested', 'deeper'), options));
    assert.ok(!isInsideOmpBlobsDir(override, options));
    assert.ok(
      !isInsideOmpBlobsDir(`${blobsDir}-sibling`, options),
      'a sibling sharing a name prefix is not inside the store'
    );
  });
});
