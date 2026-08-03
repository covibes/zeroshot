import type { TargetAdapterError } from './errors.ts';

export interface TargetAccessTokenProvider {
  getAccessToken(signal?: AbortSignal): Promise<string>;
}

export type CapsuleState = 'provisioning' | 'running' | 'stopping' | 'terminated' | 'failed' | (string & {});

export const KNOWN_CAPSULE_STATES = ['provisioning', 'running', 'stopping', 'terminated', 'failed'] as const;

export interface Capsule {
  readonly id: string;
  readonly state: CapsuleState;
  readonly createdAt: string;
  readonly [key: string]: unknown;
}

export interface CapsuleAccess {
  readonly endpoint: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface CapsuleListPage {
  readonly items: readonly Capsule[];
  readonly cursor?: string;
}

export interface CapsuleLimits {
  readonly maxConcurrent: number;
  readonly maxPerHour: number;
  readonly [key: string]: unknown;
}

export interface AllocateRequest {
  readonly idempotencyKey: string;
  readonly profile: string;
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

export interface TargetDiscovery {
  readonly capsuleV1: string;
}
