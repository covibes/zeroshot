'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  configureTargetSetup,
  checkCredentialSources,
  readInstallCredentials,
} = require('./credentials');
const { SealedInstallClient } = require('./install-client');
const { HostedRunOrchestrator } = require('./orchestrator');
const { readHostedInputs } = require('./readers');

function runtimeModule(relative) {
  return require(path.join(__dirname, '..', relative));
}

function loadRuntime() {
  return Object.freeze({
    target: runtimeModule('target'),
    hostedTarget: runtimeModule('hosted-target/index.cjs'),
    hostedSession: runtimeModule('hosted-session/index.cjs'),
    cluster: runtimeModule('cluster/index.cjs'),
  });
}

function httpTransport() {
  return { fetch: (url, init) => globalThis.fetch(url, init) };
}

function targetSettings(dependencies) {
  return {
    load: () => dependencies.loadSettings(),
    mutate: (mutator) => dependencies.mutateSettings(mutator),
  };
}

function requireTarget(name, runtime, settings) {
  const target = runtime.target.getTarget(name, settings);
  if (!target) throw new Error(`Target "${name}" not found.`);
  return target;
}

function requireOrganization(target) {
  if (!target.organization?.id)
    throw new Error('Target login is required before remote capsule operations');
}

async function createSessionContext(name, runtime, settings) {
  const target = requireTarget(name, runtime, settings);
  requireOrganization(target);
  const http = httpTransport();
  const descriptor = await runtime.target.discoverTarget(target.url, http);
  const credentialStore = await runtime.target.KeyringCredentialStore.create();
  const sessionManager = new runtime.target.TargetSessionManager({
    targetName: name,
    target,
    credentialStore,
    acquireLock: () => runtime.target.acquireTargetLock(target.id),
    settings,
    deps: {
      http,
      clock: Date,
      browserOpener: { open: () => Promise.resolve() },
      stderr: process.stderr,
      discoveryEndpoints: {
        deviceAuthorizationEndpoint: descriptor.oauth.deviceAuthorizationEndpoint,
        tokenEndpoint: descriptor.oauth.tokenEndpoint,
        revocationEndpoint: descriptor.oauth.revocationEndpoint,
        clientId: descriptor.oauth.clientId,
        capsuleApiBaseUrl: descriptor.capsule.baseUrl.replace(/\/$/, ''),
        deviceGrantType: descriptor.oauth.deviceGrantType,
        audience: descriptor.oauth.audience,
        sessionEndpoint: new URL(descriptor.session.routeTemplate.template, descriptor.origin).href,
        descriptor,
      },
    },
  });
  const adapter = runtime.hostedTarget.createTargetAdapter({
    descriptor,
    organization: { id: target.organization.id },
    tokenProvider: sessionManager.tokenProvider('capsule'),
  });
  return { target, descriptor, credentialStore, sessionManager, adapter };
}

function outputCapsule(capsule, json) {
  if (json) {
    console.log(JSON.stringify(capsule, null, 2));
  } else {
    console.log(`${capsule.id}\t${capsule.state}\t${capsule.label ?? ''}\t${capsule.createdAt}`);
  }
}

function buildManifest() {
  try {
    const manifest = require('./candidate-build.json');
    if (manifest.privateMarker !== 'ZEROSHOT_PRIVATE_HOSTED_CLI_CANDIDATE_DO_NOT_PUBLISH') {
      throw new Error('private candidate marker is missing');
    }
    return manifest;
  } catch (error) {
    throw new Error('private candidate build manifest is unavailable', { cause: error });
  }
}

function createDefaultServices(dependencies) {
  const runtime = loadRuntime();
  const settings = targetSettings(dependencies);
  const services = {
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
      const manager = new runtime.target.TargetSessionManager({
        targetName: name,
        target,
        credentialStore,
        acquireLock: () => runtime.target.acquireTargetLock(target.id),
        settings,
        deps: {
          http: httpTransport(),
          clock: Date,
          browserOpener: {
            async open(url) {
              const imported = await import('open');
              await imported.default(url);
            },
          },
          stderr: process.stderr,
          discoveryEndpoints: {
            deviceAuthorizationEndpoint: descriptor.oauth.deviceAuthorizationEndpoint,
            tokenEndpoint: descriptor.oauth.tokenEndpoint,
            revocationEndpoint: descriptor.oauth.revocationEndpoint,
            clientId: descriptor.oauth.clientId,
            capsuleApiBaseUrl: descriptor.capsule.baseUrl.replace(/\/$/, ''),
            deviceGrantType: descriptor.oauth.deviceGrantType,
            audience: descriptor.oauth.audience,
            sessionEndpoint: new URL(descriptor.session.routeTemplate.template, descriptor.origin)
              .href,
            descriptor,
          },
        },
      });
      const result = await manager.login();
      console.log(`Logged in to "${name}" (organization: ${result.organization.id})`);
    },

    async targetList(options) {
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
      try {
        const descriptor = await runtime.target.discoverTarget(target.url, httpTransport());
        const credentialStore = await runtime.target.KeyringCredentialStore.create();
        const manager = new runtime.target.TargetSessionManager({
          targetName: name,
          target,
          credentialStore,
          acquireLock: () => runtime.target.acquireTargetLock(target.id),
          settings,
          deps: {
            http: httpTransport(),
            clock: Date,
            browserOpener: { open: () => Promise.resolve() },
            stderr: process.stderr,
            discoveryEndpoints: {
              deviceAuthorizationEndpoint: descriptor.oauth.deviceAuthorizationEndpoint,
              tokenEndpoint: descriptor.oauth.tokenEndpoint,
              revocationEndpoint: descriptor.oauth.revocationEndpoint,
              clientId: descriptor.oauth.clientId,
              capsuleApiBaseUrl: descriptor.capsule.baseUrl.replace(/\/$/, ''),
              deviceGrantType: descriptor.oauth.deviceGrantType,
              audience: descriptor.oauth.audience,
              sessionEndpoint: new URL(descriptor.session.routeTemplate.template, descriptor.origin)
                .href,
              descriptor,
            },
          },
        });
        await manager.revoke(Boolean(options.force));
        const setup = target.hostedSetup;
        if (setup?.openrouter?.service && setup?.openrouter?.account) {
          await credentialStore.delete(setup.openrouter.service, setup.openrouter.account);
        }
      } catch (error) {
        if (!options.force) throw error;
      }
      runtime.target.removeTarget(name, settings);
      console.log(`Target "${name}" removed`);
    },

    async targetSetup(name, options) {
      const target = requireTarget(name, runtime, settings);
      const credentialStore = await runtime.target.KeyringCredentialStore.create();
      const metadata = await configureTargetSetup({
        targetName: name,
        target,
        repository: options.repository,
        provider: options.provider,
        settings,
        credentialStore,
      });
      console.log(
        `Configured ${name}: ${metadata.repository}, ${metadata.profile}, ${metadata.model}, ` +
          `GitHub ${metadata.github.account} via gh, OpenRouter via OS keyring`
      );
    },

    async capsuleCreate(options) {
      const context = await createSessionContext(options.target, runtime, settings);
      const capsule = await context.adapter.allocate({
        idempotencyKey: `capsule_${crypto.randomUUID().replaceAll('-', '')}`,
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.size === undefined ? {} : { size: options.size }),
      });
      console.log(`Capsule: ${capsule.id}`);
      outputCapsule(capsule, false);
    },

    async capsuleTerminate(capsuleId, options) {
      const context = await createSessionContext(options.target, runtime, settings);
      const capsule = await context.adapter.terminate(capsuleId);
      console.log(`Termination requested for capsule ${capsule.id}; host state: ${capsule.state}`);
    },

    async remoteRun(options) {
      const inputs = await readHostedInputs(
        options.graph,
        options.input,
        runtime.cluster.assertGraphSpec
      );
      const context = await createSessionContext(options.target, runtime, settings);
      const manifest = buildManifest();
      const abort = new AbortController();
      const onSigint = () =>
        abort.abort(new DOMException('remote observation interrupted', 'AbortError'));
      process.once('SIGINT', onSigint);
      try {
        const orchestrator = new HostedRunOrchestrator({
          assertGraphSpec: runtime.cluster.assertGraphSpec,
          readInputs: async () => inputs,
          checkCredentialSources,
          readCredentials: readInstallCredentials,
          installClient: new SealedInstallClient(),
          createCoordinator: (init) => new runtime.hostedSession.HostedSessionCoordinator(init),
          runtimeImageDigest: manifest.runtimeImageDigest,
        });
        return await orchestrator.run({
          ...context,
          graphPath: options.graph,
          inputPath: options.input,
          detach: Boolean(options.detach),
          signal: abort.signal,
        });
      } finally {
        process.removeListener('SIGINT', onSigint);
      }
    },

    async remoteList(options) {
      const context = await createSessionContext(options.target, runtime, settings);
      const page = await context.adapter.list(
        options.limit === undefined ? {} : { limit: options.limit }
      );
      if (options.json) {
        console.log(JSON.stringify(page, null, 2));
      } else {
        for (const capsule of page.capsules) outputCapsule(capsule, false);
        if (page.nextCursor !== null) console.log(`Next cursor: ${page.nextCursor}`);
      }
    },

    async remoteStatus(capsuleId, options) {
      const context = await createSessionContext(options.target, runtime, settings);
      const host = await context.adapter.inspect(capsuleId);
      let oecp = null;
      if (host.state === 'ready') {
        const coordinator = new runtime.hostedSession.HostedSessionCoordinator({
          adapter: context.adapter,
          capsuleId,
          targetAuthority: context.target.url,
        });
        try {
          const session = await coordinator.open();
          oecp = await session.client.get({});
        } finally {
          await coordinator.close();
        }
      }
      const result = { host, oecp };
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Host: ${host.state}`);
        console.log(`OECP: ${oecp === null ? 'unavailable' : oecp.status.phase}`);
      }
    },

    async remoteStop(capsuleId, options) {
      const context = await createSessionContext(options.target, runtime, settings);
      const host = await context.adapter.inspect(capsuleId);
      if (host.state !== 'ready')
        throw new Error(`capsule host is ${host.state}; OECP stop is unavailable`);
      const coordinator = new runtime.hostedSession.HostedSessionCoordinator({
        adapter: context.adapter,
        capsuleId,
        targetAuthority: context.target.url,
      });
      try {
        const session = await coordinator.open();
        const current = await session.client.get({});
        const generation = current.status.observedGeneration;
        if (!Number.isSafeInteger(generation) || generation < 1) {
          throw new Error('capsule has no current OECP generation to stop');
        }
        const stopped = await session.client.stop({
          idempotencyKey: `stop_${crypto.randomUUID().replaceAll('-', '')}`,
          ifGeneration: generation,
          mode: options.force ? 'force' : 'drain',
        });
        console.log(
          `OECP ${stopped.effectiveMode} stop accepted for run ${stopped.runId}; host capsule was not terminated`
        );
      } finally {
        await coordinator.close();
      }
    },
  };
  return Object.freeze(services);
}

module.exports = { createDefaultServices, createSessionContext, loadRuntime };
