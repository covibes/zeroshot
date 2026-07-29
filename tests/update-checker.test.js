const assert = require('assert');
const childProcess = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Command } = require('commander');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-update-checker-'));
const TEST_SETTINGS_FILE = path.join(TEST_DIR, 'settings.json');
const originalSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;
process.env.ZEROSHOT_SETTINGS_FILE = TEST_SETTINGS_FILE;

const settings = require('../lib/settings');
const updateChecker = require('../cli/lib/update-checker');

const TTY = { isTTY: true };
const NOT_TTY = { isTTY: false };
const PUBLISHED = {
  currentVersion: '1.2.3',
  packageName: '@the-open-engine/zeroshot',
  stdin: TTY,
  stdout: TTY,
  stderr: TTY,
  env: {},
};

function buildCommanderEligibilityFixture() {
  const cli = new Command();
  cli.name('zeroshot').version('1.2.3').option('-q, --quiet');
  cli.command('run <input>').option('-d, --detach').option('-o, --output-format <format>');
  cli
    .command('export <cluster-id>')
    .option('-f, --format <format>')
    .option('-o, --output <file>');
  cli.command('logs [id]').option('-f, --follow').option('-w, --watch');
  const task = cli.command('task');
  task.command('run <prompt>').option('-o, --output-format <format>');
  return cli;
}

function resetSettingsFile() {
  fs.rmSync(TEST_SETTINGS_FILE, { force: true });
  fs.rmSync(`${TEST_SETTINGS_FILE}.lock`, { recursive: true, force: true });
}

function validManifest(version = '2.0.0') {
  return {
    name: '@the-open-engine/zeroshot',
    version,
    dist: {
      tarball: `https://registry.npmjs.org/@the-open-engine/zeroshot/-/zeroshot-${version}.tgz`,
      integrity: 'sha512-test-integrity',
    },
  };
}

function fakeHttps({ statusCode = 200, body = validManifest(), responseError, requestEvent } = {}) {
  const calls = [];
  return {
    calls,
    get(url, options, callback) {
      calls.push({ url, options });
      const request = new EventEmitter();
      request.destroyed = false;
      request.destroy = () => {
        request.destroyed = true;
      };
      process.nextTick(() => {
        if (requestEvent) {
          request.emit(requestEvent);
          return;
        }
        const response = new EventEmitter();
        response.statusCode = statusCode;
        response.resume = () => {};
        response.destroy = () => {};
        callback(response);
        process.nextTick(() => {
          if (responseError) {
            response.emit('error', new Error(responseError));
            return;
          }
          if (body !== undefined) response.emit('data', Buffer.from(String(body)));
          response.emit('end');
        });
      });
      return request;
    },
  };
}

describe('Update Checker', function () {
  after(function () {
    if (originalSettingsFile === undefined) delete process.env.ZEROSHOT_SETTINGS_FILE;
    else process.env.ZEROSHOT_SETTINGS_FILE = originalSettingsFile;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(function () {
    resetSettingsFile();
  });

  describe('pure automatic eligibility', function () {
    const ineligible = [
      ['no arguments', []],
      ['stdin is not a TTY', ['list'], { stdin: NOT_TTY }],
      ['stdout is not a TTY', ['list'], { stdout: NOT_TTY }],
      ['stderr is not a TTY', ['list'], { stderr: NOT_TTY }],
      ['short quiet after command', ['list', '-q']],
      ['long quiet before command', ['--quiet', 'list']],
      ['grouped quiet and version before command', ['-qV', 'list']],
      ['grouped quiet and help after command', ['list', '-qh']],
      ['grouped version and quiet before command', ['-Vq', 'list']],
      ['CI pseudo-TTY', ['list'], { env: { CI: 'false' } }],
      ['boolean CI pseudo-TTY', ['list'], { env: { CI: true } }],
      ['option terminator without a command', ['--']],
      ['daemon child', ['list'], { env: { ZEROSHOT_DAEMON: '1' } }],
      ['short help', ['list', '-h']],
      ['long help', ['--help']],
      ['short version', ['-V']],
      ['long version', ['--version']],
      ['completion', ['--completion']],
      ['explicit update', ['update']],
      ['explicit update check', ['update', '--check']],
      ['task run', ['task', 'run', 'hello']],
      ['get-log-path', ['get-log-path', 'task-id']],
      ['cmdproof prove', ['cmdproof', 'prove']],
      ['cmdproof verify', ['cmdproof', 'verify']],
      ['cmdproof check', ['cmdproof', 'check']],
      ['setup plan', ['setup', 'plan']],
      ['setup apply', ['setup', 'apply']],
      ['setup undo', ['setup', 'undo']],
      ['json flag', ['list', '--json']],
      ['silent JSON', ['run', 'hello', '--silent-json-output']],
      ['JSON schema separated', ['run', 'hello', '--json-schema', '{}']],
      ['JSON schema equals', ['run', 'hello', '--json-schema={}']],
      ['JSON output separated', ['run', 'hello', '--output-format', 'json']],
      ['stream JSON output equals', ['run', 'hello', '--output-format=stream-json']],
      ['JSON export separated', ['export', 'id', '--format', 'json']],
      ['JSON export equals', ['export', 'id', '--format=json']],
      ['JSON export short format', ['export', 'id', '-f', 'json']],
      ['JSON export joined short format', ['export', 'id', '-fjson']],
      ['development build', ['list'], { currentVersion: '0.0.0-development' }],
      ['prerelease build', ['list'], { currentVersion: '1.0.0-rc.1' }],
      ['legacy package', ['list'], { packageName: '@covibes/zeroshot' }],
    ];

    for (const [name, argv, overrides = {}] of ineligible) {
      it(`rejects ${name}`, function () {
        assert.strictEqual(
          updateChecker.isAutomaticUpdateEligible({ ...PUBLISHED, argv, ...overrides }),
          false
        );
      });
    }

    it('accepts a normal foreground human TTY route', function () {
      assert.strictEqual(
        updateChecker.isAutomaticUpdateEligible({ ...PUBLISHED, argv: ['list'] }),
        true
      );
    });

    it('does not classify option-looking prompt text as an option', function () {
      assert.strictEqual(
        updateChecker.isAutomaticUpdateEligible({
          ...PUBLISHED,
          argv: [
            'run',
            'Explain why --json, -qV, -f json, -fjson, and --output-format=json are mentioned',
          ],
        }),
        true
      );
    });

    it('honors the option terminator', function () {
      assert.strictEqual(
        updateChecker.isAutomaticUpdateEligible({ ...PUBLISHED, argv: ['run', '--', '--json'] }),
        true
      );
      assert.strictEqual(
        updateChecker.isAutomaticUpdateEligible({ ...PUBLISHED, argv: ['run', '--', '-qV'] }),
        true
      );
    });

    it('does not overmatch non-JSON joined short values or unrelated short-looking flags', function () {
      assert.strictEqual(
        updateChecker.isAutomaticUpdateEligible({
          ...PUBLISHED,
          argv: ['export', 'id', '-fmarkdown'],
        }),
        true
      );
      assert.strictEqual(
        updateChecker.isAutomaticUpdateEligible({ ...PUBLISHED, argv: ['run', 'hello', '-follow'] }),
        true
      );
      assert.strictEqual(
        updateChecker.isAutomaticUpdateEligible({ ...PUBLISHED, argv: ['run', 'hello', '-qX'] }),
        true
      );
    });

    it('ignores a joined short value after the option terminator', function () {
      assert.strictEqual(
        updateChecker.isAutomaticUpdateEligible({
          ...PUBLISHED,
          argv: ['run', '--', '-fjson'],
        }),
        true
      );
    });
  });

  describe('Commander option metadata integration', function () {
    const commanderProgram = buildCommanderEligibilityFixture();

    function eligible(argv) {
      return updateChecker.isAutomaticUpdateEligible({
        ...PUBLISHED,
        argv,
        commanderProgram,
        defaultCommandName: 'run',
      });
    }

    for (const [name, argv] of [
      ['quiet plus joined JSON export format', ['export', 'id', '-qfjson']],
      ['quiet plus separated JSON export format', ['export', 'id', '-qf', 'json']],
      ['quiet after a compatible command flag', ['logs', 'id', '-fq']],
      ['quiet before a compatible command flag', ['logs', 'id', '-qf']],
      ['help after a compatible command flag', ['logs', 'id', '-fh']],
      ['version before a compatible command flag', ['logs', 'id', '-Vw']],
      ['multiple globals before a joined value option', ['export', 'id', '-qhVfjson']],
      ['global quiet before the subcommand', ['-q', 'export', 'id', '-fmarkdown']],
    ]) {
      it(`rejects ${name}`, function () {
        assert.strictEqual(eligible(argv), false);
      });
    }

    for (const [name, argv] of [
      ['joined format value containing q', ['export', 'id', '-fq']],
      ['joined output path containing q', ['export', 'id', '-oq']],
      ['unknown mixed short cluster', ['run', 'hello', '-qX']],
      ['long-looking single-dash word', ['run', 'hello', '-query']],
      ['joined non-JSON export format', ['export', 'id', '-fmarkdown']],
      ['joined format word', ['export', 'id', '-follow']],
      [
        'option text inside one prompt argument',
        ['run', 'Explain -qfjson, -query, -follow, and -fmarkdown'],
      ],
      ['options after the terminator', ['export', 'id', '--', '-qfjson']],
    ]) {
      it(`accepts ${name}`, function () {
        assert.strictEqual(eligible(argv), true);
      });
    }

    for (const [name, argv, expected] of [
      [
        'repeated long options ending in JSON',
        ['export', 'id', '--format', 'markdown', '--format', 'json'],
        false,
      ],
      [
        'repeated long options ending in markdown',
        ['export', 'id', '--format', 'json', '--format', 'markdown'],
        true,
      ],
      ['repeated joined shorts ending in JSON', ['export', 'id', '-fmarkdown', '-fjson'], false],
      ['repeated joined shorts ending in markdown', ['export', 'id', '-fjson', '-fmarkdown'], true],
      [
        'repeated separated shorts ending in JSON',
        ['export', 'id', '-f', 'markdown', '-f', 'json'],
        false,
      ],
      [
        'repeated separated shorts ending in markdown',
        ['export', 'id', '-f', 'json', '-f', 'markdown'],
        true,
      ],
      [
        'mixed forms ending in JSON',
        ['export', 'id', '--format', 'markdown', '-fjson'],
        false,
      ],
      [
        'mixed forms ending in markdown',
        ['export', 'id', '-fjson', '--format', 'markdown'],
        true,
      ],
    ]) {
      it(`uses the final value for ${name}`, function () {
        assert.strictEqual(eligible(argv), expected);
      });
    }
  });

  describe('version and attempt validation', function () {
    it('compares stable releases and treats non-release current builds as explicitly updatable', function () {
      assert.strictEqual(updateChecker.isNewerVersion('1.9.9', '1.10.0'), true);
      assert.strictEqual(updateChecker.isNewerVersion('2.0.0', '1.9.9'), false);
      assert.strictEqual(updateChecker.isNewerVersion('1.0.0', '1.0.0'), false);
      assert.strictEqual(updateChecker.isNewerVersion('1.0.0', '1.1.0-rc.1'), false);
      assert.strictEqual(updateChecker.isNewerVersion('0.0.0-development', '2.0.0'), true);
      assert.strictEqual(updateChecker.isNewerVersion('1.0.0-rc.1', '2.0.0'), true);
    });

    it('accepts only finite stable SemVer with well-formed build identifiers', function () {
      assert.deepStrictEqual(updateChecker.parseStableVersion('2.0.0+build.7'), [2, 0, 0]);
      for (const version of [
        '2.0.0+foo..bar',
        '2.0.0+.foo',
        '2.0.0+foo.',
        '9007199254740992.0.0',
        `1.0.0+${'a'.repeat(257)}`,
      ]) {
        assert.strictEqual(updateChecker.parseStableVersion(version), null, version);
      }
    });

    it('uses the exact 24-hour boundary', function () {
      const now = 10 * updateChecker.CHECK_INTERVAL_MS;
      assert.strictEqual(
        updateChecker.shouldCheckForUpdates(
          { autoCheckUpdates: true, lastUpdateCheckAt: now - updateChecker.CHECK_INTERVAL_MS + 1 },
          now
        ),
        false
      );
      assert.strictEqual(
        updateChecker.shouldCheckForUpdates(
          { autoCheckUpdates: true, lastUpdateCheckAt: now - updateChecker.CHECK_INTERVAL_MS },
          now
        ),
        true
      );
    });

    for (const timestamp of [undefined, null, '1', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      it(`treats ${String(timestamp)} as due`, function () {
        assert.strictEqual(
          updateChecker.shouldCheckForUpdates(
            { autoCheckUpdates: true, lastUpdateCheckAt: timestamp },
            1000
          ),
          true
        );
      });
    }

    it('treats a future timestamp as due and disabled settings as never due', function () {
      assert.strictEqual(
        updateChecker.shouldCheckForUpdates(
          { autoCheckUpdates: true, lastUpdateCheckAt: 1001 },
          1000
        ),
        true
      );
      assert.strictEqual(
        updateChecker.shouldCheckForUpdates(
          { autoCheckUpdates: false, lastUpdateCheckAt: null },
          1000
        ),
        false
      );
    });
  });

  describe('cached notices and claim lifecycle', function () {
    function scheduleLifecycleRefresh(callback) {
      setImmediate(callback);
      const lifecycleHandle = {};
      assert.strictEqual(typeof lifecycleHandle.unref, 'undefined');
      return lifecycleHandle;
    }

    function checkerOptions(state, overrides = {}) {
      return {
        eligibilityChecked: true,
        currentVersion: '1.0.0',
        loadSettings: () => ({ ...state }),
        mutateSettings: (mutator) => {
          const result = mutator(state);
          if (state.autoCheckUpdates === false) state.lastUpdateCheckClaim = null;
          return result;
        },
        now: () => 100 * updateChecker.CHECK_INTERVAL_MS,
        generateClaimId: () => 'claim-a',
        stderr: { write: () => {} },
        scheduleRefresh: scheduleLifecycleRefresh,
        ...overrides,
      };
    }

    it('writes the exact cached notice on every eligible invocation and never stdout', function () {
      const state = {
        autoCheckUpdates: true,
        lastSeenVersion: '2.0.0',
        lastUpdateCheckAt: 100 * updateChecker.CHECK_INTERVAL_MS,
        lastUpdateCheckClaim: null,
      };
      let stderr = '';
      const stdout = { write: () => assert.fail('automatic checker wrote stdout') };
      const stdin = { read: () => assert.fail('automatic checker read stdin') };
      const options = checkerOptions(state, {
        stdin,
        stdout,
        stderr: { write: (chunk) => (stderr += chunk) },
      });

      assert.strictEqual(updateChecker.checkForUpdates(options), null);
      assert.strictEqual(updateChecker.checkForUpdates(options), null);
      assert.strictEqual(
        stderr,
        'Update available: 1.0.0 → 2.0.0. Run `zeroshot update`.\n'.repeat(2)
      );
    });

    it('ignores older, equal, malformed, and disabled cache values', function () {
      for (const lastSeenVersion of ['0.9.0', '1.0.0', 'not-a-version', null]) {
        let stderr = '';
        const state = {
          autoCheckUpdates: true,
          lastSeenVersion,
          lastUpdateCheckAt: 100 * updateChecker.CHECK_INTERVAL_MS,
        };
        updateChecker.checkForUpdates(
          checkerOptions(state, { stderr: { write: (chunk) => (stderr += chunk) } })
        );
        assert.strictEqual(stderr, '');
      }

      let touched = false;
      updateChecker.checkForUpdates(
        checkerOptions(
          { autoCheckUpdates: false, lastSeenVersion: '2.0.0', lastUpdateCheckAt: null },
          { mutateSettings: () => (touched = true) }
        )
      );
      assert.strictEqual(touched, false);
    });

    it('claims before fetching and commits only exact timestamp and ID ownership', async function () {
      const state = {
        autoCheckUpdates: true,
        lastSeenVersion: '1.5.0',
        lastUpdateCheckAt: null,
        lastUpdateCheckClaim: null,
        unrelated: 'preserved',
      };
      let fetches = 0;
      const refresh = updateChecker.checkForUpdates(
        checkerOptions(state, {
          fetchLatestVersion: () => {
            fetches += 1;
            assert.strictEqual(state.lastUpdateCheckClaim, 'claim-a');
            return '2.0.0';
          },
        })
      );
      await refresh;

      assert.strictEqual(fetches, 1);
      assert.strictEqual(state.lastSeenVersion, '2.0.0');
      assert.strictEqual(state.lastUpdateCheckClaim, null);
      assert.strictEqual(state.unrelated, 'preserved');
    });

    it('production scheduling is unrefed and defers work until after command dispatch', async function () {
      const state = {
        autoCheckUpdates: true,
        lastSeenVersion: null,
        lastUpdateCheckAt: null,
        lastUpdateCheckClaim: null,
      };
      let scheduled;
      let unrefs = 0;
      let claims = 0;
      const originalSetImmediate = global.setImmediate;
      global.setImmediate = (callback) => {
        scheduled = callback;
        return {
          unref() {
            unrefs += 1;
          },
        };
      };
      const base = checkerOptions(state, { scheduleRefresh: undefined });
      let refresh;
      try {
        refresh = updateChecker.checkForUpdates({
          ...base,
          mutateSettings: (mutator) => {
            claims += 1;
            return base.mutateSettings(mutator);
          },
          fetchLatestVersion: () => Promise.reject(new Error('offline')),
        });
      } finally {
        global.setImmediate = originalSetImmediate;
      }

      assert.strictEqual(claims, 0);
      assert.strictEqual(unrefs, 1);
      assert.strictEqual(typeof scheduled, 'function');
      scheduled();
      await refresh;
      assert.strictEqual(claims, 1);
      assert.strictEqual(state.lastUpdateCheckClaim, 'claim-a');
    });

    it('coalesces concurrent in-process calls into one request', async function () {
      const state = {
        autoCheckUpdates: true,
        lastSeenVersion: null,
        lastUpdateCheckAt: null,
        lastUpdateCheckClaim: null,
      };
      let resolveFetch;
      let fetches = 0;
      const options = checkerOptions(state, {
        fetchLatestVersion: () => {
          fetches += 1;
          return new Promise((resolve) => {
            resolveFetch = resolve;
          });
        },
      });

      const first = updateChecker.checkForUpdates(options);
      const second = updateChecker.checkForUpdates(options);
      assert.strictEqual(first, second);
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(fetches, 1);
      resolveFetch('2.0.0');
      await first;
    });

    it('retains failed ownership and replaces it with a distinct same-millisecond claim', async function () {
      const state = {
        autoCheckUpdates: true,
        lastSeenVersion: '1.5.0',
        lastUpdateCheckAt: null,
        lastUpdateCheckClaim: null,
      };
      const claimIds = ['claim-a', 'claim-b'];
      const options = checkerOptions(state, {
        generateClaimId: () => claimIds.shift(),
        fetchLatestVersion: () => null,
      });

      await updateChecker.checkForUpdates(options);
      assert.strictEqual(state.lastUpdateCheckClaim, 'claim-a');
      const firstAttemptAt = state.lastUpdateCheckAt;

      state.lastUpdateCheckAt = null;
      await updateChecker.checkForUpdates(options);
      assert.strictEqual(state.lastUpdateCheckClaim, 'claim-b');
      assert.strictEqual(state.lastUpdateCheckAt, firstAttemptAt);
    });

    it('discards a flight after disable then re-enable invalidates its claim', async function () {
      const state = {
        autoCheckUpdates: true,
        lastSeenVersion: '1.5.0',
        lastUpdateCheckAt: null,
        lastUpdateCheckClaim: null,
      };
      let resolveFetch;
      const options = checkerOptions(state, {
        fetchLatestVersion: () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      });

      const refresh = updateChecker.checkForUpdates(options);
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(state.lastUpdateCheckClaim, 'claim-a');
      state.autoCheckUpdates = false;
      state.lastUpdateCheckClaim = null;
      state.autoCheckUpdates = true;
      resolveFetch('2.0.0');
      await refresh;

      assert.strictEqual(state.lastSeenVersion, '1.5.0');
      assert.strictEqual(state.lastUpdateCheckClaim, null);
    });

    it('silently skips network when claim persistence fails', async function () {
      let fetches = 0;
      const refresh = updateChecker.checkForUpdates(
        checkerOptions(
          { autoCheckUpdates: true, lastSeenVersion: null, lastUpdateCheckAt: null },
          {
            mutateSettings: () => {
              throw new Error('lock unavailable');
            },
            fetchLatestVersion: () => {
              fetches += 1;
              return '2.0.0';
            },
          }
        )
      );
      await refresh;
      assert.strictEqual(fetches, 0);
    });
  });

  describe('npm manifest fetching', function () {
    it('accepts only the expected installable stable manifest', function () {
      assert.strictEqual(updateChecker.validatedManifestVersion(validManifest('2.0.0')), '2.0.0');
      assert.strictEqual(
        updateChecker.validatedManifestVersion({ ...validManifest(), name: 'other' }),
        null
      );
      assert.strictEqual(updateChecker.validatedManifestVersion(validManifest('2.0.0-rc.1')), null);
      assert.strictEqual(
        updateChecker.validatedManifestVersion({ ...validManifest(), dist: { integrity: 'x' } }),
        null
      );
      assert.strictEqual(
        updateChecker.validatedManifestVersion({ ...validManifest(), dist: { tarball: 'https://x' } }),
        null
      );
    });

    it('uses one fixed HTTPS request and clears the safety timer', async function () {
      const httpsModule = fakeHttps({ body: JSON.stringify(validManifest('2.1.0')) });
      let timerCleared = false;
      const version = await updateChecker.fetchLatestVersion({
        httpsModule,
        setTimeout: () => ({ unref() {} }),
        clearTimeout: () => {
          timerCleared = true;
        },
      });

      assert.strictEqual(version, '2.1.0');
      assert.strictEqual(httpsModule.calls.length, 1);
      assert.strictEqual(
        httpsModule.calls[0].url,
        'https://registry.npmjs.org/@the-open-engine/zeroshot/latest'
      );
      assert.strictEqual(timerCleared, true);
    });

    const failures = [
      ['non-200 response', { statusCode: 503, body: '' }],
      ['malformed JSON', { body: '{' }],
      ['wrong package', { body: JSON.stringify({ ...validManifest(), name: 'wrong' }) }],
      ['prerelease', { body: JSON.stringify(validManifest('2.0.0-rc.1')) }],
      ['missing tarball', { body: JSON.stringify({ ...validManifest(), dist: { integrity: 'x' } }) }],
      ['missing integrity', { body: JSON.stringify({ ...validManifest(), dist: { tarball: 'https://x' } }) }],
      ['request error', { requestEvent: 'error' }],
      ['request timeout', { requestEvent: 'timeout' }],
    ];

    for (const [name, spec] of failures) {
      it(`returns null for ${name}`, async function () {
        const httpsModule = fakeHttps(spec);
        const version = await updateChecker.fetchLatestVersion({ httpsModule, timeoutMs: 10 });
        assert.strictEqual(version, null);
      });
    }

    it('rejects an oversized response', async function () {
      const httpsModule = fakeHttps({ body: 'x'.repeat(65) });
      const version = await updateChecker.fetchLatestVersion({ httpsModule, maxResponseBytes: 64 });
      assert.strictEqual(version, null);
    });
  });

  describe('transactional global settings', function () {
    it('normalizes claims and invalidates ownership on every disable', function () {
      settings.mutateSettings((current) => {
        current.autoCheckUpdates = true;
        current.lastUpdateCheckAt = 123;
        current.lastUpdateCheckClaim = 'claim-one';
        current.lastSeenVersion = '2.0.0';
        current.unrelated = 'keep';
      });
      settings.mutateSettings((current) => {
        current.defaultProvider = 'codex';
      });
      assert.strictEqual(settings.loadSettings().lastUpdateCheckClaim, 'claim-one');
      assert.strictEqual(settings.loadSettings().unrelated, 'keep');

      settings.mutateSettings((current) => {
        current.autoCheckUpdates = false;
      });
      assert.strictEqual(settings.loadSettings().lastUpdateCheckClaim, null);
      settings.mutateSettings((current) => {
        current.autoCheckUpdates = true;
      });
      assert.strictEqual(settings.loadSettings().lastUpdateCheckClaim, null);
      assert.strictEqual(settings.loadSettings().lastSeenVersion, '2.0.0');
    });

    it('normalizes old, malformed, and disabled claims to null', function () {
      fs.writeFileSync(
        TEST_SETTINGS_FILE,
        JSON.stringify({ autoCheckUpdates: true, lastUpdateCheckClaim: 42 }),
        'utf8'
      );
      assert.strictEqual(settings.loadSettings().lastUpdateCheckClaim, null);
      fs.writeFileSync(
        TEST_SETTINGS_FILE,
        JSON.stringify({ autoCheckUpdates: false, lastUpdateCheckClaim: 'old' }),
        'utf8'
      );
      assert.strictEqual(settings.loadSettings().lastUpdateCheckClaim, null);
    });

    it('returns callback results and atomically preserves unrelated fields', function () {
      const result = settings.mutateSettings((current) => {
        current.providerSettings.claude.defaultLevel = 'level1';
        current.unrelated = { nested: true };
        return 'committed';
      });
      assert.strictEqual(result, 'committed');
      assert.deepStrictEqual(settings.loadSettings().unrelated, { nested: true });
      assert.strictEqual(settings.loadSettings().providerSettings.claude.defaultLevel, 'level1');
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8')));
      assert.deepStrictEqual(
        fs.readdirSync(TEST_DIR).filter((name) => name.endsWith('.tmp')),
        []
      );
    });

    it('surfaces bounded lock acquisition failures actionably', function () {
      const properLockfile = require('proper-lockfile');
      const originalLockSync = properLockfile.lockSync;
      properLockfile.lockSync = () => {
        throw new Error('busy');
      };
      try {
        assert.throws(
          () => settings.mutateSettings((current) => (current.logLevel = 'verbose')),
          /Unable to persist global settings: busy/
        );
      } finally {
        properLockfile.lockSync = originalLockSync;
      }
    });
  });

  describe('explicit installer compatibility', function () {
    it('keeps the legacy forced takeover argv and current-package argv', function () {
      assert.deepStrictEqual(
        updateChecker.buildInstallArgs({ installPrefix: '/tmp/prefix', legacy: true }),
        [
          'install',
          '-g',
          '--prefix',
          '/tmp/prefix',
          '--force',
          '@the-open-engine/zeroshot@latest',
        ]
      );
      assert.deepStrictEqual(
        updateChecker.buildInstallArgs({ installPrefix: '/tmp/prefix', legacy: false }),
        ['install', '-g', '--prefix', '/tmp/prefix', '@the-open-engine/zeroshot@latest']
      );
    });

    it('dispatches every legacy first-argument update form and preserves its result', async function () {
      const invocations = [];
      for (const [argv, success] of [
        [['update'], true],
        [['update', '--check'], false],
      ]) {
        const result = await updateChecker.runLegacyUpdateIfRequested(argv, {
          packageName: '@covibes/zeroshot',
          runUpdate: () => {
            invocations.push(argv);
            return success;
          },
        });
        assert.strictEqual(result, success);
      }
      assert.deepStrictEqual(invocations, [['update'], ['update', '--check']]);
      assert.strictEqual(
        updateChecker.runLegacyUpdateIfRequested(['update', '--check'], {
          packageName: '@the-open-engine/zeroshot',
          runUpdate: () => assert.fail('current-package check must not force takeover'),
        }),
        null
      );
      assert.strictEqual(
        updateChecker.runLegacyUpdateIfRequested(['list'], {
          packageName: '@covibes/zeroshot',
          runUpdate: () => assert.fail('non-update command must not force takeover'),
        }),
        null
      );
    });


    it('keeps source-build explicit checks available and installs the current package without force', async function () {
      assert.strictEqual(updateChecker.isNewerVersion('0.0.0-development', '2.0.0'), true);
      assert.strictEqual(
        updateChecker.isAutomaticUpdateEligible({
          ...PUBLISHED,
          argv: ['list'],
          currentVersion: '0.0.0-development',
        }),
        false
      );

      const originalSpawn = childProcess.spawn;
      const installPrefix = path.join(TEST_DIR, 'source-prefix');
      fs.mkdirSync(path.join(installPrefix, 'lib', 'node_modules'), { recursive: true });
      let observed;
      childProcess.spawn = (command, args, options) => {
        observed = { command, args, options };
        const child = new EventEmitter();
        process.nextTick(() => child.emit('close', 0));
        return child;
      };

      try {
        const success = await updateChecker.runUpdate({
          packageName: '@the-open-engine/zeroshot',
          installPrefix,
          npmCommand: '/tmp/npm-for-test',
        });
        assert.strictEqual(success, true);
        assert.deepStrictEqual(observed, {
          command: '/tmp/npm-for-test',
          args: [
            'install',
            '-g',
            '--prefix',
            installPrefix,
            '@the-open-engine/zeroshot@latest',
          ],
          options: { stdio: 'inherit', shell: false },
        });
      } finally {
        childProcess.spawn = originalSpawn;
      }
    });
    it('spawns resolved npm with inherited stdio and shell disabled', async function () {
      const originalSpawn = childProcess.spawn;
      const installPrefix = path.join(TEST_DIR, 'legacy-prefix');
      fs.mkdirSync(path.join(installPrefix, 'lib', 'node_modules'), { recursive: true });
      let observed;
      childProcess.spawn = (command, args, options) => {
        observed = { command, args, options };
        const child = new EventEmitter();
        process.nextTick(() => child.emit('close', 0));
        return child;
      };

      try {
        const success = await updateChecker.runUpdate({
          packageName: '@covibes/zeroshot',
          installPrefix,
          npmCommand: '/tmp/npm-for-test',
        });
        assert.strictEqual(success, true);
        assert.deepStrictEqual(observed, {
          command: '/tmp/npm-for-test',
          args: [
            'install',
            '-g',
            '--prefix',
            installPrefix,
            '--force',
            '@the-open-engine/zeroshot@latest',
          ],
          options: { stdio: 'inherit', shell: false },
        });
      } finally {
        childProcess.spawn = originalSpawn;
      }
    });
  });
});
