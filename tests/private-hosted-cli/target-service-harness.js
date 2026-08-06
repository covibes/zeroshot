'use strict';

const { createTargetServices } = require('../../private/hosted-cli-candidate/target-services');
const { DESCRIPTOR } = require('./candidate-fixtures');

function targetHarness() {
  const calls = [];
  const state = {
    _targets: {
      prod: {
        id: 'target-prod',
        url: 'https://target.example',
        organization: { id: 'org-1' },
        createdAt: '2026-08-03T00:00:00.000Z',
      },
    },
  };
  class TargetSessionManager {
    constructor(options) {
      calls.push(['session', options.targetName]);
    }

    login() {
      calls.push(['login']);
      return { organization: { id: 'org-1' } };
    }

    revoke(force) {
      calls.push(['revoke', force]);
    }
  }
  const runtime = {
    target: {
      TARGET_ACCOUNT: 'refresh-token',
      TargetSessionManager,
      acquireTargetLock: () => undefined,
      addTarget(name, url, settings, descriptor) {
        calls.push(['add', name, url, descriptor.origin]);
        const record = {
          id: `target-${name}`,
          url,
          createdAt: '2026-08-04T00:00:00.000Z',
        };
        settings.mutate((current) => {
          current._targets[name] = record;
        });
        return record;
      },
      discoverTargetSessionEndpoints(url) {
        calls.push(['discover', url]);
        return { descriptor: DESCRIPTOR };
      },
      KeyringCredentialStore: {
        create() {
          return {
            delete(service, account) {
              calls.push(['delete', service, account]);
            },
          };
        },
      },
      listTargets(settings) {
        return Object.entries(settings.load()._targets).map(([name, record]) => ({ name, record }));
      },
      normalizeAndValidateUrl: (url) => url,
      removeTarget(name, settings) {
        calls.push(['remove', name]);
        settings.mutate((current) => {
          delete current._targets[name];
        });
      },
      targetServiceKey: (id) => `zeroshot-target-${id}`,
    },
  };
  const settings = {
    load: () => state,
    mutate: (mutator) => mutator(state),
  };
  const services = createTargetServices({
    runtime,
    settings,
    httpTransport: () => ({ fetch: () => undefined }),
    requireTarget: (name) => state._targets[name],
  });
  return { calls, services, state };
}

module.exports = { targetHarness };
