import type { HttpTransport } from './device-flow.ts';
import type { TargetSessionEndpoints } from './discovery.ts';
import { oauthFormRequest } from './oauth-http.ts';

interface RevocationDeps {
  readonly http: HttpTransport;
  readonly discoveryEndpoints: TargetSessionEndpoints;
}

export async function revokeRefreshToken(
  token: string,
  deps: RevocationDeps,
): Promise<Response> {
  const body = new URLSearchParams({
    token,
    client_id: deps.discoveryEndpoints.clientId,
    token_type_hint: 'refresh_token',
  });
  const response = await deps.http.fetch(
    deps.discoveryEndpoints.revocationEndpoint,
    oauthFormRequest(body),
  );
  if (response.url &&
      new URL(response.url).href !== deps.discoveryEndpoints.revocationEndpoint) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Target revocation response changed route or authority');
  }
  await response.body?.cancel().catch(() => undefined);
  return response;
}
