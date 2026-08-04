'use strict';

const { configureTargetSetup } = require('./credentials');
const { URL } = require('node:url');

function discoveryEndpoints(descriptor) {
  return {
    deviceAuthorizationEndpoint: descriptor.oauth.deviceAuthorizationEndpoint,
    tokenEndpoint: descriptor.oauth.tokenEndpoint,
    revocationEndpoint: descriptor.oauth.revocationEndpoint,
    clientId: descriptor.oauth.clientId,
    capsuleApiBaseUrl: descriptor.capsule.baseUrl.replace(/\/$/, ''),
    deviceGrantType: descriptor.oauth.deviceGrantType,
    audience: descriptor.oauth.audience,
    sessionEndpoint: new URL(descriptor.session.routeTemplate.template, descriptor.origin).href,
    descriptor,
  };
}

function targetSessionManager({
  runtime,
  settings,
  name,
  target,
  descriptor,
  credentialStore,
  open,
  http = { fetch: (url, init) => globalThis.fetch(url, init) },
}) {
  return new runtime.target.TargetSessionManager({
    targetName: name,
    target,
    credentialStore,
    acquireLock: () => runtime.target.acquireTargetLock(target.id),
    settings,
    deps: {
      http,
      clock: Date,
      browserOpener: { open },
      stderr: process.stderr,
      discoveryEndpoints: discoveryEndpoints(descriptor),
    },
  });
}

async function deleteTargetCredentials(runtime, target, credentialStore) {
  try {
    await credentialStore.delete(
      runtime.target.targetServiceKey(target.id),
      runtime.target.TARGET_ACCOUNT
    );
  } catch {
    throw new Error(
      'Local login credential cleanup failed; target settings were preserved for an exact retry.'
    );
  }
}

function createTargetServices({ runtime, settings, httpTransport, requireTarget }) {
  const managerFor = (values, open) => targetSessionManager({ runtime, settings, ...values, open });
  return {
    async targetAdd(name, options) {
      const url = runtime.target.normalizeAndValidateUrl(options.url);
      const descriptor = await runtime.target.discoverTarget(url, httpTransport());
      const record = runtime.target.addTarget(name, url, settings, descriptor);
      console.log(`Target "${name}" added (${record.url})`);
    },

    async targetLogin(name) {
      const target = requireTarget(name, runtime, settings);
      const descriptor = await runtime.target.discoverTarget(target.url, httpTransport());
      const credentialStore = await runtime.target.KeyringCredentialStore.create();
      const manager = managerFor({ name, target, descriptor, credentialStore }, async (url) => {
        const imported = await import('open');
        await imported.default(url);
      });
      const result = await manager.login();
      console.log(`Logged in to "${name}" (organization: ${result.organization.id})`);
    },

    targetList(options) {
      const targets = runtime.target.listTargets(settings);
      if (options.json) {
        const rows = targets.map(({ name, record }) => ({
          name,
          id: record.id,
          url: record.url,
          organization: record.organization ?? null,
          configured: record.hostedSetup?.kind === 'zeroshot.private-hosted-setup/v1',
          createdAt: record.createdAt,
        }));
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (targets.length === 0) {
        console.log('No targets registered.');
        return;
      }
      for (const { name, record } of targets) {
        console.log(`${name}\t${record.url}\t${record.organization?.id ?? 'not-logged-in'}`);
      }
    },

    async targetRemove(name, options) {
      const target = requireTarget(name, runtime, settings);
      const credentialStore = await runtime.target.KeyringCredentialStore.create();
      let remoteError;
      try {
        const descriptor = await runtime.target.discoverTarget(target.url, httpTransport());
        const manager = managerFor({ name, target, descriptor, credentialStore }, () =>
          Promise.resolve()
        );
        await manager.revoke(Boolean(options.force));
      } catch (error) {
        remoteError = error;
      }
      if (remoteError && !options.force) throw remoteError;
      await deleteTargetCredentials(runtime, target, credentialStore);
      runtime.target.removeTarget(name, settings);
      console.log(`Target "${name}" removed`);
    },

    async targetSetup(name, options) {
      const target = requireTarget(name, runtime, settings);
      const metadata = await configureTargetSetup({
        targetName: name,
        target,
        repository: options.repository,
        provider: options.provider,
        modelLevel: options.modelLevel,
        settings,
      });
      console.log(
        `Configured ${name}: ${metadata.repository}, ${metadata.provider}, ${metadata.modelLevel}`
      );
    },
  };
}

module.exports = { createTargetServices, targetSessionManager };
