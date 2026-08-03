import { acquireTargetLock } from '../credential-lock.ts';
import { KeyringCredentialStore } from '../credential-store.ts';
import { discoverTargetSessionEndpoints } from '../discovery.ts';
import { getTarget } from '../target-registry.ts';
import { getAccessTokenProvider, type TargetAccessTokenProvider } from '../target-session.ts';
import { readBoundedJson } from '../bounded-json.ts';

import type { HostedRunDependencies, HostedRunIntent } from './contracts.ts';

const MAX_RESPONSE_BYTES = 1024 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const RUN_INTENT_STATES = new Set([
  'queued',
  'provisioning',
  'running',
  'cancelling',
  ...TERMINAL_STATES,
]);

export interface HostedContext {
  readonly targetName: string;
  readonly organization: string;
  readonly client: RunIntentClient;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class HostedRunHttpError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = 'HostedRunHttpError';
    this.status = status;
    this.code = code;
  }
}

function validateIntent(value: unknown): HostedRunIntent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Zero Cloud returned an invalid run intent');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record['intent_id'] !== 'string' ||
    !UUID.test(record['intent_id']) ||
    typeof record['state'] !== 'string' ||
    !RUN_INTENT_STATES.has(record['state'])
  ) {
    throw new Error('Zero Cloud returned an invalid run intent');
  }
  const result = record['result'];
  if (result !== null && (typeof result !== 'object' || Array.isArray(result))) {
    throw new Error('Zero Cloud returned an invalid run intent result');
  }
  return record as unknown as HostedRunIntent;
}

export class RunIntentClient {
  private readonly baseUrl: string;
  private readonly organization: string;
  private readonly tokenProvider: TargetAccessTokenProvider;
  private readonly fetch: typeof globalThis.fetch;

  constructor(
    baseUrl: string,
    organization: string,
    tokenProvider: TargetAccessTokenProvider,
    fetchImplementation: typeof globalThis.fetch
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.organization = organization;
    this.tokenProvider = tokenProvider;
    this.fetch = fetchImplementation;
  }

  async submit(body: Record<string, unknown>, submissionKey: string): Promise<HostedRunIntent> {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.request('', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Idempotency-Key': submissionKey },
        });
      } catch (error) {
        failure = error;
        if (error instanceof HostedRunHttpError && error.status < 500) throw error;
        if (attempt === 0) await wait(250);
      }
    }
    throw failure;
  }

  get(intentId: string): Promise<HostedRunIntent> {
    return this.request(`/${encodeURIComponent(intentId)}`, { method: 'GET' });
  }

  cancel(intentId: string): Promise<HostedRunIntent> {
    return this.request(`/${encodeURIComponent(intentId)}`, { method: 'DELETE' });
  }

  private async request(
    suffix: string,
    options: { method: string; body?: string; headers?: Record<string, string> }
  ): Promise<HostedRunIntent> {
    const token = await this.tokenProvider.getAccessToken();
    const url = `${this.baseUrl}/orgs/${encodeURIComponent(this.organization)}/run-intents${suffix}`;
    const init: RequestInit & { redirect: 'error' } = {
      method: options.method,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    };
    if (options.body !== undefined) init.body = options.body;
    let response: Response;
    try {
      response = await this.fetch(url, init);
    } catch (error) {
      throw new Error(
        `Zero Cloud request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const body = await readBoundedJson(response, MAX_RESPONSE_BYTES, {
      tooLarge: () => new Error('Zero Cloud response exceeded 1 MiB'),
      invalid: () => new Error('Zero Cloud returned invalid JSON'),
    });
    if (!response.ok) {
      const problem = body as Record<string, unknown>;
      const code = typeof problem['code'] === 'string' ? problem['code'] : null;
      const message =
        typeof problem['message'] === 'string' ? problem['message'] : 'request failed';
      throw new HostedRunHttpError(
        response.status,
        `Zero Cloud ${response.status}: ${message}`,
        code
      );
    }
    return validateIntent(body);
  }
}

export async function context(targetName: string, deps: HostedRunDependencies): Promise<HostedContext> {
  const environment = deps.environment ?? process.env;
  const target = getTarget(targetName, deps.settings);
  if (!target) throw new Error(`Target "${targetName}" not found.`);
  const http = {
    fetch: (url: string, init: RequestInit & { redirect: 'error' }) =>
      (deps.fetch ?? globalThis.fetch)(url, init),
  };
  const discovery = await discoverTargetSessionEndpoints(target.url, http);
  const ephemeralToken = environment['ZEROSHOT_TARGET_ACCESS_TOKEN']?.trim();
  const ephemeralOrganization = environment['ZEROSHOT_TARGET_ORGANIZATION']?.trim();
  if ((ephemeralToken && !ephemeralOrganization) || (!ephemeralToken && ephemeralOrganization)) {
    throw new Error(
      'ZEROSHOT_TARGET_ACCESS_TOKEN and ZEROSHOT_TARGET_ORGANIZATION must be provided together'
    );
  }

  let organization: string;
  let tokenProvider: TargetAccessTokenProvider;
  if (ephemeralToken && ephemeralOrganization) {
    organization = ephemeralOrganization;
    tokenProvider = { getAccessToken: async () => ephemeralToken };
  } else {
    if (!target.organization) {
      throw new Error(`Login required. Run: zeroshot target login ${targetName}`);
    }
    organization = target.organization.id;
    const credentials = await KeyringCredentialStore.create();
    tokenProvider = getAccessTokenProvider(
      targetName,
      target,
      credentials,
      () => acquireTargetLock(target.id),
      { http, discoveryEndpoints: discovery }
    );
  }

  return {
    targetName,
    organization,
    client: new RunIntentClient(
      discovery.capsuleApiBaseUrl,
      organization,
      tokenProvider,
      deps.fetch ?? globalThis.fetch
    ),
  };
}
