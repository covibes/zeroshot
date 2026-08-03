import type { TargetAdapterError } from './errors.ts';

export interface TargetAccessTokenProvider {
  getAccessToken(signal?: AbortSignal): Promise<string>;
}

export type CapsuleState = 'provisioning' | 'ready' | 'terminating' | 'terminated' | 'failed';
export const KNOWN_CAPSULE_STATES = ['provisioning', 'ready', 'terminating', 'terminated', 'failed'] as const;

export interface Capsule {
  readonly id: string;
  readonly state: CapsuleState;
  readonly label: string | null;
  readonly createdAt: string;
}

export interface CapsuleAccess {
  readonly protocol: 'openengine.cluster/v1';
  readonly websocketUrl: string;
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresAt: string;
}

export interface CapsuleListPage {
  readonly capsules: readonly Capsule[];
  readonly nextCursor: string | null;
}

export interface CapsuleLimits {
  readonly activeCapsules: number;
  readonly maxActiveCapsules: number | null;
}

export interface AllocateRequest {
  readonly idempotencyKey: string;
  readonly label?: string;
  readonly size?: 'tiny' | 'small' | 'standard' | 'large';
}
export interface ListRequest {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface HttpTransport {
  fetch(url: string, init: RequestInit & { redirect: 'error' }): Promise<Response>;
}

export interface Clock {
  now(): number;
}

export interface RetryPolicy {
  shouldRetry(
    attempt: number,
    elapsed: number,
    error: TargetAdapterError,
  ): { retry: boolean; delayMs: number };
}
