const assert = require('assert');
const path = require('path');

const { getProviderMetadata } = require('../../lib/provider-names');
const {
  PROVIDER_READINESS,
  assessProviderReadiness,
  providerChoices,
} = require('../../cli/lib/setup-provider-readiness');

function assess(probe, overrides = {}) {
  return assessProviderReadiness({
    providerId: 'codex',
    probe,
    isolation: 'worktree',
    settings: { providerSettings: {} },
    ...overrides,
  });
}

describe('setup provider readiness', function () {
  it('uses the closed status vocabulary', function () {
    assert.deepStrictEqual(PROVIDER_READINESS, [
      'ready',
      'login-required',
      'incompatible',
      'unavailable',
      'unknown',
    ]);
  });

  it('classifies ready, login-required, unavailable, and unknown probes', function () {
    assert.deepStrictEqual(
      assess({ available: true, authStatus: 'ready', path: '/usr/bin/codex' }),
      { status: 'ready', selectable: true, reason: '/usr/bin/codex' }
    );
    assert.strictEqual(
      assess({ available: true, authStatus: 'login-required', authReason: 'codex login' }).status,
      'login-required'
    );
    assert.strictEqual(assess({ available: false, commandAvailable: false }).status, 'unavailable');
    assert.strictEqual(assess({ available: false, commandAvailable: true }).status, 'unknown');
    assert.strictEqual(assess(null).status, 'unknown');
  });

  it('rejects OMP omp-home authentication for detached worktree execution', function () {
    const metadata = getProviderMetadata('omp');
    const readiness = assessProviderReadiness({
      providerId: 'omp',
      probe: { available: true, authStatus: 'ready', path: '/usr/bin/omp' },
      isolation: 'worktree',
      settings: {
        providerSettings: {
          omp: {
            ...metadata.settingsDefaults,
            auth: { mode: 'omp-home', path: path.join('/tmp', 'omp-agent') },
          },
        },
      },
    });
    assert.strictEqual(readiness.status, 'incompatible');
    assert.strictEqual(readiness.selectable, false);
    assert.match(readiness.reason, /local host-only.*forbidden.*detached or Docker/i);
  });

  it('keeps every provider visible while disabling non-ready choices', function () {
    const plan = {
      facts: {
        providers: {
          codex: { available: true },
          gemini: { available: false },
        },
      },
    };
    const choices = providerChoices({
      plan,
      probes: {
        'provider:codex': {
          available: true,
          authStatus: 'ready',
          path: '/usr/bin/codex',
        },
        'provider:gemini': {
          available: false,
          commandAvailable: false,
        },
      },
      isolation: 'worktree',
      settings: { providerSettings: {} },
    });
    assert.deepStrictEqual(
      choices.map(({ value, status, disabled }) => ({ value, status, disabled })),
      [
        { value: 'codex', status: 'ready', disabled: false },
        { value: 'gemini', status: 'unavailable', disabled: true },
      ]
    );
  });
});
