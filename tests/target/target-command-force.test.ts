import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Command } from 'commander';
import { registerHostedCommands } from '../helpers/target-runtime.mjs';

describe('private target remove --force', () => {
  it('deletes local credentials when discovery is unavailable', async () => {
    const target = {
      id: 'target-1',
      url: 'https://offline.example',
      createdAt: '2026-08-03T00:00:00Z',
    };
    const state: { _targets?: Record<string, typeof target> } = {
      _targets: { primary: target },
    };
    let deletes = 0;
    const program = new Command();
    registerHostedCommands(program, {
      loadSettings: () => state,
      mutateSettings: (mutator) => mutator(state),
      services: {
        addTarget: () => target,
        normalizeAndValidateUrl: String,
        discoverTarget: async () => ({
          origin: target.url,
          adapter: { majorVersion: 1 },
        }),
        getTarget: () => target,
        listTargets: () => [],
        removeTarget: () => {
          delete state._targets?.primary;
          return target;
        },
        targetLogin: async () => ({ organization: { name: 'unused' } }),
        revokeAndCleanup: async () => assert.fail('revocation must not run without discovery'),
        KeyringCredentialStore: {
          create: async () => ({
            get: async () => null,
            set: async () => undefined,
            delete: async () => {
              deletes += 1;
            },
          }),
        },
        targetServiceKey: (id) => `zeroshot-target-${id}`,
        TARGET_ACCOUNT: 'refresh-token',
        acquireTargetLock: async () => async () => undefined,
        discoverTargetSessionEndpoints: async () => {
          throw new Error('target offline');
        },
      },
    });

    await program.parseAsync([
      'node',
      'test',
      'target',
      'remove',
      'primary',
      '--force',
    ]);

    assert.equal(deletes, 1);
    assert.equal(state._targets?.primary, undefined);
  });
});
