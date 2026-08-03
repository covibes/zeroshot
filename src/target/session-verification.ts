import type { HttpTransport } from './device-flow.js';
import type { TargetSessionEndpoints } from './discovery.js';
import { readTargetSessionJson } from './oauth-http.js';

interface SessionVerificationDeps {
  readonly http: HttpTransport;
  readonly discoveryEndpoints: TargetSessionEndpoints;
}

function parseOrganization(value: unknown): { readonly id: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Target session response is malformed');
  }
  const body = value as Record<string, unknown>;
  const fields = Object.keys(body);
  if (fields.length !== 2 || !fields.includes('kind') ||
      !fields.includes('organization_id') ||
      body.kind !== 'openengine.target-session/v1' ||
      typeof body.organization_id !== 'string' ||
      body.organization_id.length === 0 || body.organization_id.length > 256) {
    throw new Error('Target session response is malformed');
  }
  return Object.freeze({ id: body.organization_id });
}

export async function readVerifiedOrganization(
  accessToken: string,
  signal: AbortSignal | undefined,
  deps: SessionVerificationDeps,
): Promise<{ readonly id: string }> {
  const init: RequestInit & { redirect: 'error' } = {
    method: deps.discoveryEndpoints.descriptor.session.method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Cache-Control': 'no-store',
    },
    redirect: 'error',
  };
  if (signal !== undefined) init.signal = signal;
  const response = await deps.http.fetch(deps.discoveryEndpoints.sessionEndpoint, init);
  if (response.url && new URL(response.url).href !== deps.discoveryEndpoints.sessionEndpoint) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Target session response changed route or authority');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Target session verification failed');
  }
  return parseOrganization(await readTargetSessionJson(response));
}
