import { ClusterConfigError, connectInitialized } from '../cluster/index.js';
import type { ServerCapabilities, GraphProfile } from '../cluster/index.js';
import type { ConnectOptions } from '../cluster/index.js';
import type { AccessResponse, HostedSessionInit, InitializedSession } from './types.js';

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  return AbortSignal.any(defined);
}

export class HostedSessionCoordinator {
  readonly #getAccess: (signal?: AbortSignal) => Promise<AccessResponse>;
  readonly #connectOptions: Omit<ConnectOptions, 'headers' | 'signal'> | undefined;
  readonly #clock: { now(): number };
  readonly #closeController = new AbortController();
  #referenceCapabilities: ServerCapabilities | undefined;
  #closed = false;

  constructor(init: HostedSessionInit) {
    this.#getAccess = init.getAccess;
    this.#connectOptions = init.connectOptions;
    this.#clock = init.clock ?? Date;
  }

  async open(signal?: AbortSignal): Promise<InitializedSession> {
    this.#requireNotClosed();
    const session = await this.#createSession(signal);
    this.#referenceCapabilities = session.initializeResult.capabilities;
    return session;
  }

  async replace(signal?: AbortSignal): Promise<InitializedSession> {
    this.#requireNotClosed();
    const session = await this.#createSession(signal);
    this.#verifyCapabilities(session.initializeResult.capabilities, session);
    return session;
  }

  renewalDeadline(access: AccessResponse, receivedAt: number): number {
    const expiresAt = Date.parse(access.expiresAt);
    if (Number.isNaN(expiresAt)) {
      throw new ClusterConfigError(`invalid expiresAt: ${access.expiresAt}`, 'INVALID_EXPIRY');
    }
    const lifetime = expiresAt - receivedAt;
    return Math.min(expiresAt - 30_000, receivedAt + 0.8 * lifetime);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#closeController.abort();
  }

  async #createSession(signal?: AbortSignal): Promise<InitializedSession> {
    const combined = combineSignals([signal, this.#closeController.signal]);
    const access = await this.#getAccess(combined);
    const expiresAt = Date.parse(access.expiresAt);
    if (Number.isNaN(expiresAt)) {
      throw new ClusterConfigError(`invalid expiresAt: ${access.expiresAt}`, 'INVALID_EXPIRY');
    }
    if (expiresAt <= this.#clock.now()) {
      throw new ClusterConfigError('access token is already expired', 'ACCESS_EXPIRED');
    }

    let endpoint: URL;
    try {
      endpoint = new URL(access.endpoint);
    } catch {
      throw new ClusterConfigError('hosted access endpoint is invalid', 'INVALID_ENDPOINT');
    }
    if (endpoint.protocol !== 'wss:') {
      throw new ClusterConfigError('hosted access endpoint must use wss', 'INSECURE_ENDPOINT');
    }

    return connectInitialized(endpoint.href, {
      ...this.#connectOptions,
      headers: { Authorization: `Bearer ${access.token}` },
      ...(combined !== undefined ? { signal: combined } : {}),
    });
  }

  #verifyCapabilities(incoming: ServerCapabilities, session: InitializedSession): void {
    if (!this.#referenceCapabilities) return;
    const ref = this.#referenceCapabilities;
    const mismatches: string[] = [];

    if (ref.graphProfiles) {
      const incomingProfiles = new Set<GraphProfile>(incoming.graphProfiles ?? []);
      for (const profile of ref.graphProfiles) {
        if (!incomingProfiles.has(profile)) mismatches.push(`missing graphProfile: ${profile}`);
      }
    }
    if (ref.logs && !incoming.logs) mismatches.push('missing capability: logs');
    if (ref.agentAttach && !incoming.agentAttach)
      mismatches.push('missing capability: agentAttach');

    if (mismatches.length > 0) {
      void session.connection.close();
      throw new ClusterConfigError(
        `replacement capabilities incompatible: ${mismatches.join(', ')}`,
        'INCOMPATIBLE_CAPABILITIES'
      );
    }
  }

  #requireNotClosed(): void {
    if (this.#closed) throw new ClusterConfigError('coordinator is closed', 'COORDINATOR_CLOSED');
  }
}
