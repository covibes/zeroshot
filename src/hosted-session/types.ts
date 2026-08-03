import type { Connection } from '../cluster/index.js';
import type { ClusterClient, ConnectOptions } from '../cluster/index.js';
import type { InitializeResult } from '../cluster/index.js';

export interface AccessResponse {
  readonly endpoint: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface HostedSessionInit {
  readonly getAccess: (signal?: AbortSignal) => Promise<AccessResponse>;
  readonly connectOptions?: Omit<ConnectOptions, 'headers' | 'signal'>;
  readonly clock?: { now(): number };
}

export interface InitializedSession {
  readonly connection: Connection;
  readonly client: ClusterClient;
  readonly initializeResult: InitializeResult;
}
