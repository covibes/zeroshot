import type { TargetCredentialStore } from './credential-store.ts';
import type { TargetRecord, SettingsPort } from './target-registry.ts';
import {
  requestDeviceCode,
  pollForToken,
  UnboundSessionError,
  type HttpTransport,
  type Clock,
  type TokenResponse,
} from './device-flow.ts';
import { targetServiceKey, TARGET_ACCOUNT } from './credential-store.ts';
import { updateTargetOrganization } from './target-registry.ts';

export class LoginRequiredError extends Error {
  readonly targetName: string;
  constructor(targetName: string) {
    super(`Login required. Run: zeroshot target login ${targetName}`);
    this.name = 'LoginRequiredError';
    this.targetName = targetName;
  }
}

export interface BrowserOpener {
  open(url: string): Promise<void>;
}

export interface TargetSessionDeps {
  readonly http: HttpTransport;
  readonly clock: Clock;
  readonly browserOpener: BrowserOpener;
  readonly stderr: { write(s: string): void };
  readonly discoveryEndpoints: {
    readonly deviceAuthorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly revocationEndpoint?: string;
    readonly clientId: string;
  };
}

export async function targetLogin(
  targetName: string,
  target: TargetRecord,
  credentialStore: TargetCredentialStore,
  acquireLock: () => Promise<() => Promise<void>>,
  settings: SettingsPort,
  deps: TargetSessionDeps
): Promise<{ organization: { id: string; name: string } }> {
  const { http, clock, browserOpener, stderr, discoveryEndpoints } = deps;
  const { deviceAuthorizationEndpoint, tokenEndpoint, clientId } = discoveryEndpoints;

  const codeResponse = await requestDeviceCode(deviceAuthorizationEndpoint, clientId, http);

  stderr.write(
    `\nOpen this URL to authorize:\n  ${codeResponse.verification_uri}\n\nEnter code: ${codeResponse.user_code}\n\n`
  );

  if (codeResponse.verification_uri_complete) {
    try {
      await browserOpener.open(codeResponse.verification_uri_complete);
    } catch {
      // Browser open is best-effort
    }
  }

  const tokenResponse = await pollForToken(
    tokenEndpoint,
    clientId,
    codeResponse.device_code,
    codeResponse.interval,
    codeResponse.expires_in,
    http,
    clock
  );

  if (!tokenResponse.organization) {
    throw new UnboundSessionError(codeResponse.verification_uri);
  }

  const serviceKey = targetServiceKey(target.id);
  const release = await acquireLock();
  try {
    await credentialStore.set(serviceKey, TARGET_ACCOUNT, tokenResponse.refresh_token);
  } finally {
    await release();
  }

  updateTargetOrganization(targetName, tokenResponse.organization, settings);

  return { organization: tokenResponse.organization };
}

export async function refreshAccessToken(
  targetName: string,
  target: TargetRecord,
  credentialStore: TargetCredentialStore,
  acquireLock: () => Promise<() => Promise<void>>,
  deps: Pick<TargetSessionDeps, 'http' | 'discoveryEndpoints'>
): Promise<{ accessToken: string; expiresIn: number }> {
  const { http, discoveryEndpoints } = deps;
  const { tokenEndpoint, revocationEndpoint, clientId } = discoveryEndpoints;
  const serviceKey = targetServiceKey(target.id);

  const release = await acquireLock();
  try {
    const currentRefreshToken = await credentialStore.get(serviceKey, TARGET_ACCOUNT);
    if (!currentRefreshToken) {
      throw new LoginRequiredError(targetName);
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken,
      client_id: clientId,
    });

    let tokenResponse: TokenResponse;
    const response = await http.fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'error',
    });

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({ error: 'unknown' }))) as {
        error: string;
      };
      if (errorBody.error === 'invalid_grant') {
        await credentialStore.delete(serviceKey, TARGET_ACCOUNT);
        throw new LoginRequiredError(targetName);
      }
      throw new Error(`Token refresh failed (${response.status}): ${errorBody.error}`);
    }

    tokenResponse = (await response.json()) as TokenResponse;

    try {
      await credentialStore.set(serviceKey, TARGET_ACCOUNT, tokenResponse.refresh_token);
    } catch {
      await bestEffortRevoke(tokenResponse.refresh_token, revocationEndpoint, clientId, http);
      await credentialStore.delete(serviceKey, TARGET_ACCOUNT);
      throw new LoginRequiredError(targetName);
    }

    return { accessToken: tokenResponse.access_token, expiresIn: tokenResponse.expires_in };
  } finally {
    await release();
  }
}

async function bestEffortRevoke(
  token: string,
  revocationEndpoint: string | undefined,
  clientId: string,
  http: HttpTransport
): Promise<void> {
  if (!revocationEndpoint) return;
  try {
    const body = new URLSearchParams({
      token,
      client_id: clientId,
      token_type_hint: 'refresh_token',
    });
    await http.fetch(revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'error',
    });
  } catch {
    // Best-effort
  }
}

export interface TargetAccessTokenProvider {
  getAccessToken(signal?: AbortSignal): Promise<string>;
}

export function getAccessTokenProvider(
  targetName: string,
  target: TargetRecord,
  credentialStore: TargetCredentialStore,
  acquireLock: () => Promise<() => Promise<void>>,
  deps: Pick<TargetSessionDeps, 'http' | 'discoveryEndpoints'>,
  clock: Clock = { now: () => Date.now() }
): TargetAccessTokenProvider {
  let cachedToken: string | null = null;
  let expiresAt = 0;

  return {
    async getAccessToken(_signal?: AbortSignal): Promise<string> {
      if (cachedToken && clock.now() < expiresAt - 30_000) {
        return cachedToken;
      }
      const result = await refreshAccessToken(
        targetName,
        target,
        credentialStore,
        acquireLock,
        deps
      );
      cachedToken = result.accessToken;
      expiresAt = clock.now() + result.expiresIn * 1000;
      return result.accessToken;
    },
  };
}

export async function revokeAndCleanup(
  target: TargetRecord,
  credentialStore: TargetCredentialStore,
  acquireLock: () => Promise<() => Promise<void>>,
  deps: Pick<TargetSessionDeps, 'http' | 'discoveryEndpoints'>,
  force: boolean
): Promise<void> {
  const { http, discoveryEndpoints } = deps;
  const { revocationEndpoint, clientId } = discoveryEndpoints;
  const serviceKey = targetServiceKey(target.id);

  const release = await acquireLock();
  try {
    const refreshToken = await credentialStore.get(serviceKey, TARGET_ACCOUNT);
    if (refreshToken && revocationEndpoint) {
      const body = new URLSearchParams({
        token: refreshToken,
        client_id: clientId,
        token_type_hint: 'refresh_token',
      });
      try {
        const response = await http.fetch(revocationEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          redirect: 'error',
        });
        if (!response.ok && !force) {
          throw new Error(
            `Remote revocation failed (${response.status}). Use --force to remove anyway.`
          );
        }
      } catch (err) {
        if (!force) throw err;
      }
    }
    await credentialStore.delete(serviceKey, TARGET_ACCOUNT);
  } finally {
    await release();
  }
}
