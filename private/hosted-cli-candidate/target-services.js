'use strict';

const { configureTargetSetup } = require('./credentials');

function targetSessionManager({
  runtime,
  settings,
  name,
  target,
  endpoints,
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
      discoveryEndpoints: endpoints,
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

async function targetAdd(service, name, options) {
  const url = service.runtime.target.normalizeAndValidateUrl(options.url);
  const endpoints = await service.runtime.target.discoverTargetSessionEndpoints(
    url,
    service.httpTransport()
  );
  const record = service.runtime.target.addTarget(
    name,
    url,
    service.settings,
    endpoints.descriptor
  );
  console.log(`Target "${name}" added (${record.url})`);
}

async function targetLogin(service, name) {
  const target = service.requireTarget(name, service.runtime, service.settings);
  const endpoints = await service.runtime.target.discoverTargetSessionEndpoints(
    target.url,
    service.httpTransport()
  );
  const credentialStore = await service.runtime.target.KeyringCredentialStore.create();
  const manager = service.managerFor({ name, target, endpoints, credentialStore }, async (url) => {
    const imported = await import('open');
    await imported.default(url);
  });
  const result = await manager.login();
  console.log(`Logged in to "${name}" (organization: ${result.organization.id})`);
}

function targetList(service, options) {
  const targets = service.runtime.target.listTargets(service.settings);
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
}

async function targetRemove(service, name, options) {
  const target = service.requireTarget(name, service.runtime, service.settings);
  const credentialStore = await service.runtime.target.KeyringCredentialStore.create();
  let remoteError;
  try {
    const endpoints = await service.runtime.target.discoverTargetSessionEndpoints(
      target.url,
      service.httpTransport()
    );
    const manager = service.managerFor({ name, target, endpoints, credentialStore }, () =>
      Promise.resolve()
    );
    await manager.revoke(Boolean(options.force));
  } catch (error) {
    remoteError = error;
  }
  if (remoteError && !options.force) throw remoteError;
  await deleteTargetCredentials(service.runtime, target, credentialStore);
  service.runtime.target.removeTarget(name, service.settings);
  console.log(`Target "${name}" removed`);
}

async function targetSetup(service, name, options) {
  const target = service.requireTarget(name, service.runtime, service.settings);
  const metadata = await configureTargetSetup({
    targetName: name,
    target,
    repository: options.repository,
    provider: options.provider,
    modelLevel: options.modelLevel,
    settings: service.settings,
  });
  console.log(
    `Configured ${name}: ${metadata.repository}, ${metadata.provider}, ${metadata.modelLevel}`
  );
}

function createTargetServices({ runtime, settings, httpTransport, requireTarget }) {
  const service = {
    runtime,
    settings,
    httpTransport,
    requireTarget,
    managerFor: (values, open) => targetSessionManager({ runtime, settings, ...values, open }),
  };
  return {
    targetAdd: (name, options) => targetAdd(service, name, options),
    targetLogin: (name) => targetLogin(service, name),
    targetList: (options) => targetList(service, options),
    targetRemove: (name, options) => targetRemove(service, name, options),
    targetSetup: (name, options) => targetSetup(service, name, options),
  };
}

module.exports = { createTargetServices, targetSessionManager };
