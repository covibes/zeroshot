/**
 * Tests for provider-detection cross-platform CLI lookup.
 *
 * Regression: on Windows the lookup used the POSIX builtin `command -v`,
 * which does not exist under cmd.exe, so every provider was reported as
 * "not found". The lookup must use `where` on win32 and `command -v` elsewhere.
 */
const { expect } = require('chai');
const sinon = require('sinon');
const childProcess = require('child_process');

function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('provider-detection', () => {
  let execSyncStub;
  let detection;

  beforeEach(() => {
    // Stub before requiring the module so its destructured reference is the stub.
    execSyncStub = sinon.stub(childProcess, 'execSync');
    delete require.cache[require.resolve('../lib/provider-detection.js')];
    detection = require('../lib/provider-detection.js');
  });

  afterEach(() => {
    sinon.restore();
    delete require.cache[require.resolve('../lib/provider-detection.js')];
  });

  it('preserves the CommonJS export surface', () => {
    expect(Reflect.ownKeys(detection)).to.deep.equal([
      'commandExists',
      'getCommandPath',
      'getHelpOutput',
      'getVersionOutput',
    ]);
    expect(Object.values(detection).map((value) => value.length)).to.deep.equal([1, 1, 1, 1]);
  });

  describe('commandExists', () => {
    it('returns false for empty command without probing', () => {
      expect(detection.commandExists('')).to.equal(false);
      expect(execSyncStub.called).to.equal(false);
    });

    it('uses `where` on win32', () => {
      execSyncStub.returns('C:\\bin\\claude.exe');
      withPlatform('win32', () => {
        expect(detection.commandExists('claude')).to.equal(true);
      });
      expect(execSyncStub.firstCall.args[0]).to.equal('where claude');
    });

    it('uses `command -v` on non-win32', () => {
      execSyncStub.returns('/usr/bin/claude');
      withPlatform('linux', () => {
        expect(detection.commandExists('claude')).to.equal(true);
      });
      expect(execSyncStub.firstCall.args[0]).to.equal('command -v claude');
    });

    it('returns false when the probe throws (command missing)', () => {
      execSyncStub.throws(new Error('not found'));
      withPlatform('win32', () => {
        expect(detection.commandExists('nope')).to.equal(false);
      });
    });
  });

  describe('getCommandPath', () => {
    it('returns the first match line on win32 (`where` may return many)', () => {
      execSyncStub.returns('C:\\a\\claude.exe\r\nC:\\b\\claude.cmd\r\n');
      let result;
      withPlatform('win32', () => {
        result = detection.getCommandPath('claude');
      });
      expect(result).to.equal('C:\\a\\claude.exe');
      expect(execSyncStub.firstCall.args[0]).to.equal('where claude');
    });

    it('returns null when the probe throws', () => {
      execSyncStub.throws(new Error('not found'));
      withPlatform('linux', () => {
        expect(detection.getCommandPath('nope')).to.equal(null);
      });
    });
  });
});
