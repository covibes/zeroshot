import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  cancelHostedRun,
  runHosted,
  statusHostedRun,
  validateHostedOptions,
} from '../../src/target/hosted-run.ts';
import { FakeHttpTransport, makeSettingsPort, makeTarget, respond } from './harness.ts';

const TARGET = 'https://api.test.example';
const ORG = '019fc767-b3cc-7780-b62a-4b6989a21291';
const INTENT = '019fc767-b3cc-7780-b62a-4b6989a21292';

function readDiscoveryFixture(): Record<string, unknown> {
  const source = readFileSync(
    resolve(
      'tests/fixtures/zero-cloud-44/contracts/http/hosted-target/fixtures/valid/hosted-target-v1-minimal.json',
    ),
    'utf8',
  ).replaceAll('https://hosted.openengine.example', TARGET);
  const parsed: unknown = JSON.parse(source);
  if (parsed === null || typeof parsed !== 'object' || !('body' in parsed)) {
    throw new Error('Frozen hosted target fixture is malformed');
  }
  const body = parsed.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Frozen hosted target fixture body is malformed');
  }
  return body as Record<string, unknown>;
}

const DISCOVERY_FIXTURE = readDiscoveryFixture();

function discovery(): Record<string, unknown> {
  return structuredClone(DISCOVERY_FIXTURE);
}

function metadata(): Record<string, unknown> {
  return {
    device_authorization_endpoint: `${TARGET}/auth/device/code`,
    token_endpoint: `${TARGET}/auth/token`,
    revocation_endpoint: `${TARGET}/auth/revoke`,
  };
}

function intent(state: string, result: Record<string, unknown> | null = null) {
  return {
    intent_id: INTENT,
    state,
    waiting_reason: null,
    capsule_id: null,
    result,
    error_code: null,
    submitted_at: '2026-08-03T00:00:00Z',
    updated_at: '2026-08-03T00:00:00Z',
    terminal_at: state === 'succeeded' ? '2026-08-03T00:00:01Z' : null,
  };
}

function harness(http: FakeHttpTransport) {
  const settings = makeSettingsPort({
    _targets: { local: makeTarget({ url: TARGET }) },
  });
  const lines: string[] = [];
  return {
    settings,
    environment: {
      ZEROSHOT_TARGET_ACCESS_TOKEN: 'capsule-access-token',
      ZEROSHOT_TARGET_ORGANIZATION: ORG,
      GH_TOKEN: 'github-token',
      OPENROUTER_API_KEY: 'openrouter-token',
    },
    fetch: http.fetch.bind(http) as typeof globalThis.fetch,
    delay: async () => {},
    stdout: { write: (value: string) => lines.push(value) },
    lines,
  };
}

function enqueueDiscovery(http: FakeHttpTransport): void {
  http.enqueue(respond(200, discovery()));
  http.enqueue(respond(200, metadata()));
}

describe('opaque hosted runs', () => {
  it('submits through the named target and detaches after the durable receipt', async () => {
    const http = new FakeHttpTransport();
    enqueueDiscovery(http);
    http.enqueue(respond(202, intent('queued')));
    const deps = harness(http);

    const created = await runHosted(
      'ship the queue',
      {
        target: 'local',
        repository: 'the-open-engine/zeroshot',
        model: 'openai/gpt-5.4',
        size: 'tiny',
        detach: true,
      },
      deps
    );

    assert.equal(created?.['intent_id'], INTENT);
    assert.match(deps.lines.join(''), new RegExp(`Run ${INTENT} queued`));
    const submission = http.requests[2]!;
    assert.equal(submission.url, `${TARGET}/api/v1/orgs/${ORG}/run-intents`);
    assert.equal(submission.headers['Authorization'], 'Bearer capsule-access-token');
    assert.match(submission.headers['Idempotency-Key'] ?? '', /^[0-9a-f-]{36}$/);
    const body = JSON.parse(submission.body!);
    assert.deepEqual(body.intent.credentials, {
      githubToken: 'github-token',
      openrouterApiKey: 'openrouter-token',
      repository: 'the-open-engine/zeroshot',
      model: 'openai/gpt-5.4',
    });
    assert.equal(body.intent.request.prompt, 'ship the queue');
  });

  it('follows independently of the submission connection and prints the terminal summary', async () => {
    const http = new FakeHttpTransport();
    enqueueDiscovery(http);
    http.enqueue(respond(202, intent('queued')));
    http.enqueue(respond(200, intent('succeeded', { summary: 'finished remotely' })));
    const deps = harness(http);

    const result = await runHosted(
      'ship the queue',
      { target: 'local', repository: 'the-open-engine/zeroshot' },
      deps
    );

    assert.deepEqual(result, { summary: 'finished remotely' });
    assert.match(deps.lines.join(''), /Ctrl\+C disconnects without cancelling/);
    assert.match(deps.lines.join(''), /finished remotely/);
  });

  it('supports status and cancellation as separate CLI sessions', async () => {
    const statusHttp = new FakeHttpTransport();
    enqueueDiscovery(statusHttp);
    statusHttp.enqueue(respond(200, intent('queued')));
    const statusDeps = harness(statusHttp);
    await statusHostedRun('local', INTENT, false, statusDeps);
    assert.match(statusDeps.lines.join(''), /"state": "queued"/);

    const cancelHttp = new FakeHttpTransport();
    enqueueDiscovery(cancelHttp);
    cancelHttp.enqueue(respond(202, intent('cancelling')));
    const cancelDeps = harness(cancelHttp);
    await cancelHostedRun('local', INTENT, cancelDeps);
    assert.match(cancelDeps.lines.join(''), /cancelling/);
    assert.equal(cancelHttp.requests[2]!.method, 'DELETE');
  });

  it('rejects hosted-only flags without a valid target configuration', () => {
    assert.throws(
      () => validateHostedOptions({ target: 'local', size: 'enormous' }),
      /--size tiny, small, standard, or large/
    );
    assert.throws(
      () => validateHostedOptions({ target: 'local', provider: 'claude' }),
      /do not support --provider/
    );
  });
});
