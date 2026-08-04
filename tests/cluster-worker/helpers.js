'use strict';

const { createLegacyClusterWorker } = require('../../lib/cluster-worker');
const { createDeploymentProfileRegistry } = require('../../lib/cluster-worker/profiles');

const ARTIFACT = Object.freeze({
  artifactId: 'artifact-1',
  sha256: 'a'.repeat(64),
  byteLength: 12,
  mediaType: 'text/plain',
  typeId: 'openengine.test.text@1',
  producer: Object.freeze({ node: 'node.test', worker: 'worker.test@1' }),
  lineage: Object.freeze({ generation: 0, runId: 'run-1', attempt: 1 }),
  redaction: 'internal',
});

function request(source = 'prompt') {
  const base = {
    source,
    artifacts: source === 'artifact' ? [ARTIFACT] : [],
    isolationProfile: 'isolation.worktree@1',
    providerProfile: 'provider.default@1',
    repository: 'the-open-engine/zeroshot',
    provider: 'codex',
    modelLevel: 'level2',
  };
  if (source === 'issue') base.issue = 'https://example.test/issues/1';
  if (source === 'prompt') base.prompt = 'Run the bounded task';
  return base;
}

function registry(bounds = {}) {
  return createDeploymentProfileRegistry({ bounds });
}

function fakeEngine() {
  const calls = { starts: [], stops: 0, statuses: 0, closes: 0 };
  let onEvent;
  return {
    calls,
    adapter: Object.freeze({
      async start(value) {
        onEvent = value.onEvent;
        const artifactManifest =
          value.request.source === 'artifact'
            ? await value.prepareArtifacts(
                Object.freeze({
                  kind: 'worktree',
                  hostRoot: '/isolated/worktree',
                  runtimeRoot: '/isolated/worktree',
                })
              )
            : { artifacts: [] };
        calls.starts.push({ ...value, artifactManifest });
        return {
          clusterId: value.clusterId,
          artifactsStaged: value.request.source !== 'artifact' || Boolean(artifactManifest),
        };
      },
      status() {
        calls.statuses += 1;
        return { state: 'running' };
      },
      stop() {
        calls.stops += 1;
        return { effective: true };
      },
      close() {
        calls.closes += 1;
      },
    }),
    emit(event) {
      onEvent(event);
    },
  };
}

function workerWith(engine, overrides = {}) {
  return createLegacyClusterWorker({
    profileRegistry: registry(),
    engineAdapter: engine.adapter,
    idFactory: () => 'cluster-1',
    clock: () => 100,
    ...overrides,
  });
}

module.exports = { ARTIFACT, fakeEngine, registry, request, workerWith };
