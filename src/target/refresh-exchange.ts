import { oauthFormRequest, type HttpTransport } from './device-flow.ts';
import { readOAuthError, readTargetSessionJson } from './oauth-http.ts';
import { parseTokenResponse, type TokenResponse } from './token-response.ts';

export interface RefreshExchangeRequest {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly audience: string;
  readonly http: HttpTransport;
  readonly signal?: AbortSignal;
}

export async function exchangeRefreshToken(
  request: RefreshExchangeRequest,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: request.clientId,
    refresh_token: request.refreshToken,
    audience: request.audience,
  });
  const response = await request.http.fetch(
    request.tokenEndpoint,
    oauthFormRequest(body, request.signal),
  );
  if (response.url && new URL(response.url).href !== request.tokenEndpoint) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Target token response changed route or authority');
  }
  if (!response.ok) {
    await readOAuthError(response);
    throw new Error('Target token exchange failed');
  }
  return parseTokenResponse(await readTargetSessionJson(response));
}
