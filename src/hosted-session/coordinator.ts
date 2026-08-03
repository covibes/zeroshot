import {
  ClusterConfigError,
  ClusterUpgradeError,
  connectInitialized,
  type ServerCapabilities,
  type GraphProfile,
} from '../cluster/index.js';
import type {
  HostedAccess,
  HostedSessionInit,
  HostedWatch,
  HostedWatchOptions,
  InitializedSession,
} from './types.js';
import { normalizedAuthority, validateHostedAccess } from './authority.js';
import { HostedAuthenticationError } from './errors.js';
import { ReconnectingHostedWatch } from './reconnecting-watch.js';
export {
  HostedAuthenticationError,
  HostedAuthorizationError,
  HostedTransportUncertainError,
} from './errors.js';


function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const defined = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  return AbortSignal.any(defined);
}

export class HostedSessionCoordinator {
  readonly #init: HostedSessionInit;
  readonly #targetAuthority: string;
  readonly #clock: { now(): number };
  readonly #closeController = new AbortController();
  readonly #sessions = new Set<InitializedSession>();
  #referenceCapabilities: ServerCapabilities | undefined;
  #closed = false;

  constructor(init: HostedSessionInit) {
    if (init.capsuleId.length === 0)
      throw new ClusterConfigError('capsuleId must not be empty', 'INVALID_CAPSULE_ID');
    this.#init = init;
    this.#targetAuthority = normalizedAuthority(init.targetAuthority);
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
    try {
      if (this.#referenceCapabilities !== undefined) {
        this.#verifyCapabilities(
          this.#referenceCapabilities,
          session.initializeResult.capabilities
        );
      }
      return session;
    } catch (error) {
      await session.connection.close();
      throw error;
    }
  }

  async watch(options: HostedWatchOptions): Promise<HostedWatch> {
    const session = await this.open(options.signal);
    try {
      const subscription = await session.client.watch(
        options.params,
        options.signal === undefined ? {} : { signal: options.signal }
      );
      const hosted = new ReconnectingHostedWatch(
        (replacementSignal) => this.replace(replacementSignal),
        session,
        subscription,
        options.signal,
      );
      options.signal?.addEventListener(
        'abort',
        () => {
          void hosted.cancel().catch(() => undefined);
        },
        { once: true }
      );
      if (options.signal?.aborted) {
        await hosted.cancel();
        throw options.signal.reason ?? new DOMException('hosted watch aborted', 'AbortError');
      }
      return hosted;
    } catch (error) {
      await session.connection.close();
      throw error;
    }
  }

  renewalDeadline(access: HostedAccess, receivedAt: number): number {
    const expiresAt = Date.parse(access.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= receivedAt) {
      throw new ClusterConfigError(
        'access expiry must be a future RFC 3339 timestamp',
        'INVALID_ACCESS_EXPIRY'
      );
    }
    const lifetime = expiresAt - receivedAt;
    const lead = Math.max(5_000, Math.min(60_000, Math.floor(lifetime * 0.1)));
    return Math.max(receivedAt, expiresAt - lead);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeController.abort(new DOMException('coordinator closed', 'AbortError'));
    const sessions = [...this.#sessions];
    await Promise.all(sessions.map((session) => session.connection.close()));
    this.#sessions.clear();
  }

  async #createSession(signal?: AbortSignal): Promise<InitializedSession> {
    const combined = combineSignals([signal, this.#closeController.signal]);
    const access = await this.#init.adapter.access(this.#init.capsuleId, combined);
    validateHostedAccess(access, this.#targetAuthority);
    const receivedAt = this.#clock.now();
    this.renewalDeadline(access, receivedAt);
    try {
      const session = await connectInitialized(access.websocketUrl, {
        ...this.#init.connectOptions,
        headers: { Authorization: `Bearer ${access.accessToken}` },
        ...(combined === undefined ? {} : { signal: combined }),
      });
      this.#sessions.add(session);
      void session.connection.closed.then(() => this.#sessions.delete(session));
      return session;
    } catch (error) {
      if (error instanceof ClusterUpgradeError && error.status === 401)
        throw new HostedAuthenticationError();
      throw error;
    }
  }


  #verifyCapabilities(reference: ServerCapabilities, incoming: ServerCapabilities): void {
    const referenceProfiles = new Set<GraphProfile>(reference.graphProfiles ?? []);
    const incomingProfiles = new Set<GraphProfile>(incoming.graphProfiles ?? []);
    if (
      (reference.logs && !incoming.logs) ||
      (reference.agentAttach && !incoming.agentAttach) ||
      [...referenceProfiles].some((profile) => !incomingProfiles.has(profile))
    ) {
      throw new ClusterConfigError(
        'replacement connection removed required server capabilities',
        'CAPABILITY_REGRESSION'
      );
    }
  }

  #requireNotClosed(): void {
    if (this.#closed) throw new ClusterConfigError('coordinator is closed', 'COORDINATOR_CLOSED');
  }
}
