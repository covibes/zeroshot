import type { Connection, ClusterClient, ConnectOptions, InitializeResult, WatchParams, WatchSubscriptionItem } from '../cluster/index.js';
export interface HostedAccess {
  readonly protocol: 'openengine.cluster/v1';
  readonly websocketUrl: string;
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresAt: string;
}

export interface HostedAccessAdapter {
  access(capsuleId: string, signal?: AbortSignal): Promise<HostedAccess>;
}

export interface HostedSessionInit {
  readonly adapter: HostedAccessAdapter;
  readonly capsuleId: string;
  readonly targetAuthority: string;
  readonly connectOptions?: Omit<ConnectOptions, 'headers' | 'signal'>;
  readonly clock?: { now(): number };
}

export interface InitializedSession {
  readonly connection: Connection;
  readonly client: ClusterClient;
  readonly initializeResult: InitializeResult;
}

export interface HostedWatch extends AsyncIterator<WatchSubscriptionItem>, AsyncIterable<WatchSubscriptionItem> {
  cancel(): Promise<void>;
}

export interface HostedWatchOptions {
  readonly params: WatchParams;
  readonly signal?: AbortSignal;
}
