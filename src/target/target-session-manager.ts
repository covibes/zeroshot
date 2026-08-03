import type { TargetCredentialStore } from './credential-store.ts';
import {
  oauthFormRequest,
  readOAuthError,
  readTargetSessionJson,
} from './oauth-http.ts';
import type { TargetRecord, SettingsPort } from './target-registry.ts';
import {
  requestDeviceCode,
  pollForToken,
  parseTokenResponse,
  type HttpTransport,
  type Clock,
  type TokenResponse,
} from './device-flow.ts';
import { targetServiceKey, TARGET_ACCOUNT } from './credential-store.ts';
import {
  setTargetRefreshInvalidated,
  targetRefreshIsInvalidated,
  updateTargetOrganization,
} from './target-registry.ts';
import type { TargetSessionEndpoints } from './discovery.ts';
import { LoginRequiredError } from './session-errors.ts';
export { LoginRequiredError } from './session-errors.ts';
import { readVerifiedOrganization } from './session-verification.ts';
import { revokeRefreshToken } from './refresh-revocation.ts';

const DEVICE_LABEL = 'zeroshot-cli';
const TOKEN_EXPIRY_SKEW_MS = 30_000;
const AUDIENCE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const INVALID_REFRESH_FAMILY = 'zeroshot.invalidated-refresh-family/v1';


export interface BrowserOpener {
  open(url: string): Promise<void>;
}

export interface TargetSessionDeps {
  readonly http: HttpTransport;
  readonly clock: Clock;
  readonly browserOpener: BrowserOpener;
  readonly stderr: { write(s: string): void };
  readonly discoveryEndpoints: TargetSessionEndpoints;
}

export interface TargetSessionManagerInit {
  readonly targetName: string;
  readonly target: TargetRecord;
  readonly credentialStore: TargetCredentialStore;
  readonly acquireLock: () => Promise<() => Promise<void>>;
  readonly settings: SettingsPort;
  readonly deps: TargetSessionDeps;
}

interface CachedAccess {
  readonly token: string;
  readonly expiresAt: number;
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError');
}

function requireAudience(audience: string): void {
  if (!AUDIENCE_PATTERN.test(audience)) throw new Error('Requested target audience is invalid');
}

/**
 * Sole owner of one target's rotating refresh family and audience-scoped access cache.
 * The cross-process lock covers durable reread, exchange, replacement, and invalidation.
 */
export class TargetSessionManager {
  readonly #targetName: string;
  readonly #target: TargetRecord;
  readonly #store: TargetCredentialStore;
  readonly #acquireLock: () => Promise<() => Promise<void>>;
  readonly #settings: SettingsPort;
  readonly #deps: TargetSessionDeps;
  readonly #access = new Map<string, CachedAccess>();

  constructor(init: TargetSessionManagerInit) {
    this.#targetName = init.targetName;
    this.#target = init.target;
    this.#store = init.credentialStore;
    this.#acquireLock = init.acquireLock;
    this.#settings = init.settings;
    this.#deps = init.deps;
  }

  async login(signal?: AbortSignal): Promise<{ organization: { id: string } }> {
    const endpoints = this.#deps.discoveryEndpoints;
    const code = await requestDeviceCode(
      endpoints.deviceAuthorizationEndpoint,
      endpoints.clientId,
      this.#deps.http,
      signal
    );
    this.#deps.stderr.write(
      `\nOpen this URL to authorize:\n  ${code.verification_uri}\n\nEnter code: ${code.user_code}\n\n`
    );
    if (code.verification_uri_complete) {
      try {
        await this.#deps.browserOpener.open(code.verification_uri_complete);
      } catch {
        // Opening a browser is explicitly optional; polling remains authoritative.
      }
    }

    const release = await this.#acquireLock();
    try {
      const storedPrevious = await this.#store.get(this.#serviceKey(), TARGET_ACCOUNT);
      const previous = storedPrevious === INVALID_REFRESH_FAMILY ? null : storedPrevious;

      const token = await pollForToken(
        endpoints.tokenEndpoint,
        endpoints.clientId,
        code.device_code,
        code.interval,
        code.expires_in,
        this.#deps.http,
        this.#deps.clock,
        signal,
        {
          grantType: endpoints.deviceGrantType,
          deviceToken: this.#target.deviceToken,
          deviceLabel: DEVICE_LABEL,
          audience: endpoints.audience,
        }
      );
      const organization = await readVerifiedOrganization(
        token.access_token,
        signal,
        this.#deps,
      ).catch(
        async () => {
          await this.#bestEffortRevoke(token.refresh_token);
          throw new LoginRequiredError(this.#targetName);
        }
      );
      try {
        await this.#store.set(this.#serviceKey(), TARGET_ACCOUNT, token.refresh_token);
        setTargetRefreshInvalidated(this.#targetName, false, this.#settings);
        this.#access.set(endpoints.audience, {
          token: token.access_token,
          expiresAt: this.#deps.clock.now() + token.expires_in * 1_000,
        });
        updateTargetOrganization(this.#targetName, organization, this.#settings);
        if (previous && previous !== token.refresh_token) {
          const revoked = await revokeRefreshToken(previous, this.#deps);
          if (!revoked.ok) throw new Error('Prior refresh family revocation failed');
        }
      } catch {
        await this.#invalidateFamily(token.refresh_token);
        throw new LoginRequiredError(this.#targetName);
      }
      return { organization };
    } finally {
      await release();
    }
  }

  async getAccessTokenWithLifetime(
    audience: string,
    signal?: AbortSignal,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    requireAudience(audience);
    const cached = this.#access.get(audience);
    if (cached !== undefined && this.#deps.clock.now() < cached.expiresAt - TOKEN_EXPIRY_SKEW_MS) {
      return {
        accessToken: cached.token,
        expiresIn: Math.max(0, Math.floor((cached.expiresAt - this.#deps.clock.now()) / 1_000)),
      };
    }
    if (signal?.aborted) throw abortReason(signal);

    const release = await this.#acquireLock();
    try {
      const afterLock = this.#access.get(audience);
      if (
        afterLock !== undefined &&
        this.#deps.clock.now() < afterLock.expiresAt - TOKEN_EXPIRY_SKEW_MS
      ) {
        return {
          accessToken: afterLock.token,
          expiresIn: Math.max(
            0,
            Math.floor((afterLock.expiresAt - this.#deps.clock.now()) / 1_000),
          ),
        };
      }
      if (targetRefreshIsInvalidated(this.#targetName, this.#settings)) {
        throw new LoginRequiredError(this.#targetName);
      }
      const refreshToken = await this.#store.get(this.#serviceKey(), TARGET_ACCOUNT);
      if (!refreshToken || refreshToken === INVALID_REFRESH_FAMILY) {
        throw new LoginRequiredError(this.#targetName);
      }
      if (signal?.aborted) throw abortReason(signal);
      setTargetRefreshInvalidated(this.#targetName, true, this.#settings);
      await this.#store.set(this.#serviceKey(), TARGET_ACCOUNT, INVALID_REFRESH_FAMILY);

      let dispatched = false;
      let replacement: TokenResponse | undefined;
      try {
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.#deps.discoveryEndpoints.clientId,
          refresh_token: refreshToken,
          audience,
        });
        dispatched = true;
        const response = await this.#deps.http.fetch(
          this.#deps.discoveryEndpoints.tokenEndpoint,
          oauthFormRequest(body, signal)
        );
        if (
          response.url &&
          new URL(response.url).href !== this.#deps.discoveryEndpoints.tokenEndpoint
        ) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error('Target token response changed route or authority');
        }
        if (!response.ok) {
          const oauthError = await readOAuthError(response);
          if (oauthError === 'invalid_grant') throw new LoginRequiredError(this.#targetName);
          throw new Error('Target token exchange failed');
        }
        replacement = parseTokenResponse(await readTargetSessionJson(response));
        await this.#store.set(this.#serviceKey(), TARGET_ACCOUNT, replacement.refresh_token);
        setTargetRefreshInvalidated(this.#targetName, false, this.#settings);
        this.#access.clear();
        this.#access.set(audience, {
          token: replacement.access_token,
          expiresAt: this.#deps.clock.now() + replacement.expires_in * 1_000,
        });
        return { accessToken: replacement.access_token, expiresIn: replacement.expires_in };
      } catch (error) {
        if (!dispatched && signal?.aborted) throw abortReason(signal);
        await this.#invalidateFamily(replacement?.refresh_token);
        if (error instanceof LoginRequiredError) throw error;
        throw new LoginRequiredError(this.#targetName);
      }
    } finally {
      await release();
    }
  }

  async getAccessToken(audience: string, signal?: AbortSignal): Promise<string> {
    return (await this.getAccessTokenWithLifetime(audience, signal)).accessToken;
  }

  tokenProvider(audience: string): { getAccessToken(signal?: AbortSignal): Promise<string> } {
    requireAudience(audience);
    return Object.freeze({
      getAccessToken: (signal?: AbortSignal) => this.getAccessToken(audience, signal),
    });
  }

  async revoke(force: boolean): Promise<void> {
    const release = await this.#acquireLock();
    try {
      const token = await this.#store.get(this.#serviceKey(), TARGET_ACCOUNT);
      if (token && token !== INVALID_REFRESH_FAMILY) {
        try {
          const response = await revokeRefreshToken(token, this.#deps);
          if (!response.ok && !force)
            throw new Error('Remote revocation failed. Use --force to remove anyway.');
        } catch (error) {
          if (!force) throw error;
        }
      }
      this.#access.clear();
      await this.#store.delete(this.#serviceKey(), TARGET_ACCOUNT);
      setTargetRefreshInvalidated(this.#targetName, false, this.#settings);
    } finally {
      await release();
    }
  }

  clearMemory(): void {
    this.#access.clear();
  }


  async #invalidateFamily(replacement?: string): Promise<void> {
    this.#access.clear();
    setTargetRefreshInvalidated(this.#targetName, true, this.#settings);
    try {
      await this.#store.set(this.#serviceKey(), TARGET_ACCOUNT, INVALID_REFRESH_FAMILY);
    } catch {
      // A direct delete remains safe if overwriting the stale family was unavailable.
    }
    if (replacement) await this.#bestEffortRevoke(replacement);
    await this.#store.delete(this.#serviceKey(), TARGET_ACCOUNT);
  }

  async #bestEffortRevoke(token: string): Promise<void> {
    try {
      await revokeRefreshToken(token, this.#deps);
    } catch {
      // Revocation is compensating cleanup; callers still receive login-required.
    }
  }


  #serviceKey(): string {
    return targetServiceKey(this.#target.id);
  }
}
