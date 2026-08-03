import type { TargetCredentialStore } from './credential-store.ts';
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
import { updateTargetOrganization } from './target-registry.ts';
import type { TargetSessionEndpoints } from './discovery.ts';

const DEVICE_LABEL = 'zeroshot-cli';
const TOKEN_EXPIRY_SKEW_MS = 30_000;
const AUDIENCE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_SESSION_RESPONSE_BYTES = 64 * 1024;

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

function formRequest(
  body: URLSearchParams,
  signal?: AbortSignal
): RequestInit & { redirect: 'error' } {
  const init: RequestInit & { redirect: 'error' } = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'error',
  };
  if (signal !== undefined) init.signal = signal;
  return init;
}

function safeObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Target session response is malformed');
  }
  return value as Record<string, unknown>;
}

async function readOAuthError(response: Response): Promise<string | null> {
  try {
    const value = safeObject(await readBoundedJson(response));
    return Object.keys(value).length === 1 && typeof value.error === 'string' ? value.error : null;
  } catch {
    return null;
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_SESSION_RESPONSE_BYTES)
  ) {
    throw new Error('Target session response exceeds the size limit');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SESSION_RESPONSE_BYTES)
    throw new Error('Target session response exceeds the size limit');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Target session response is malformed');
  }
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
      let previous: string | null;
      try {
        previous = await this.#store.get(this.#serviceKey(), TARGET_ACCOUNT);
      } catch {
        throw new LoginRequiredError(this.#targetName);
      }

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
      const organization = await this.#readVerifiedOrganization(token.access_token, signal).catch(
        async () => {
          await this.#bestEffortRevoke(token.refresh_token);
          throw new LoginRequiredError(this.#targetName);
        }
      );
      try {
        await this.#store.set(this.#serviceKey(), TARGET_ACCOUNT, token.refresh_token);
        this.#access.set(endpoints.audience, {
          token: token.access_token,
          expiresAt: this.#deps.clock.now() + token.expires_in * 1_000,
        });
        updateTargetOrganization(this.#targetName, organization, this.#settings);
        if (previous && previous !== token.refresh_token) {
          const revoked = await this.#revoke(previous);
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

  async getAccessToken(audience: string, signal?: AbortSignal): Promise<string> {
    requireAudience(audience);
    const cached = this.#access.get(audience);
    if (cached !== undefined && this.#deps.clock.now() < cached.expiresAt - TOKEN_EXPIRY_SKEW_MS) {
      return cached.token;
    }
    if (signal?.aborted) throw abortReason(signal);

    const release = await this.#acquireLock();
    try {
      const afterLock = this.#access.get(audience);
      if (
        afterLock !== undefined &&
        this.#deps.clock.now() < afterLock.expiresAt - TOKEN_EXPIRY_SKEW_MS
      ) {
        return afterLock.token;
      }
      const refreshToken = await this.#store.get(this.#serviceKey(), TARGET_ACCOUNT);
      if (!refreshToken) throw new LoginRequiredError(this.#targetName);
      if (signal?.aborted) throw abortReason(signal);

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
          formRequest(body, signal)
        );
        if (!response.ok) {
          const oauthError = await readOAuthError(response);
          if (oauthError === 'invalid_grant') throw new LoginRequiredError(this.#targetName);
          throw new Error('Target token exchange failed');
        }
        replacement = parseTokenResponse(await response.json());
        await this.#store.set(this.#serviceKey(), TARGET_ACCOUNT, replacement.refresh_token);
        this.#access.clear();
        this.#access.set(audience, {
          token: replacement.access_token,
          expiresAt: this.#deps.clock.now() + replacement.expires_in * 1_000,
        });
        return replacement.access_token;
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
      if (token) {
        try {
          const response = await this.#revoke(token);
          if (!response.ok && !force)
            throw new Error('Remote revocation failed. Use --force to remove anyway.');
        } catch (error) {
          if (!force) throw error;
        }
      }
      this.#access.clear();
      await this.#store.delete(this.#serviceKey(), TARGET_ACCOUNT);
    } finally {
      await release();
    }
  }

  clearMemory(): void {
    this.#access.clear();
  }

  async #readVerifiedOrganization(
    accessToken: string,
    signal?: AbortSignal
  ): Promise<{ id: string }> {
    const init: RequestInit & { redirect: 'error' } = {
      method: this.#deps.discoveryEndpoints.descriptor.session.method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Cache-Control': 'no-store',
      },
      redirect: 'error',
    };
    if (signal !== undefined) init.signal = signal;
    const response = await this.#deps.http.fetch(
      this.#deps.discoveryEndpoints.sessionEndpoint,
      init
    );
    if (
      response.url &&
      new URL(response.url).origin !== this.#deps.discoveryEndpoints.descriptor.origin
    ) {
      throw new Error('Target session response changed authority');
    }
    if (!response.ok) throw new Error('Target session verification failed');
    const body = safeObject(await readBoundedJson(response));
    const fields = Object.keys(body);
    if (
      fields.length !== 2 ||
      !fields.includes('kind') ||
      !fields.includes('organization_id') ||
      body.kind !== 'openengine.target-session/v1' ||
      typeof body.organization_id !== 'string' ||
      body.organization_id.length === 0 ||
      body.organization_id.length > 256
    ) {
      throw new Error('Target session response is malformed');
    }
    return Object.freeze({ id: body.organization_id });
  }

  async #invalidateFamily(replacement?: string): Promise<void> {
    this.#access.clear();
    if (replacement) await this.#bestEffortRevoke(replacement);
    try {
      await this.#store.delete(this.#serviceKey(), TARGET_ACCOUNT);
    } catch {
      throw new LoginRequiredError(this.#targetName);
    }
  }

  async #bestEffortRevoke(token: string): Promise<void> {
    try {
      await this.#revoke(token);
    } catch {
      // Revocation is compensating cleanup; callers still receive login-required.
    }
  }

  #revoke(token: string): Promise<Response> {
    const body = new URLSearchParams({
      token,
      client_id: this.#deps.discoveryEndpoints.clientId,
      token_type_hint: 'refresh_token',
    });
    return this.#deps.http.fetch(
      this.#deps.discoveryEndpoints.revocationEndpoint,
      formRequest(body)
    );
  }

  #serviceKey(): string {
    return targetServiceKey(this.#target.id);
  }
}
