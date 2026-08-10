import type { TargetDiscoveryDescriptor } from '../target/discovery.js';
import type {
  AllocateRequest,
  Capsule,
  CapsuleAccess,
  CapsuleLimits,
  CapsuleListPage,
  Clock,
  HttpTransport,
  ListRequest,
  RetryPolicy,
  TargetAccessTokenProvider,
} from './types.js';

export interface TargetAdapter {
  allocate(req: AllocateRequest, signal?: AbortSignal): Promise<Capsule>;
  list(req?: ListRequest, signal?: AbortSignal): Promise<CapsuleListPage>;
  inspect(capsuleId: string, signal?: AbortSignal): Promise<Capsule>;
  terminate(capsuleId: string, signal?: AbortSignal): Promise<Capsule>;
  limits(signal?: AbortSignal): Promise<CapsuleLimits>;
  access(capsuleId: string, signal?: AbortSignal): Promise<CapsuleAccess>;
}

export interface CreateTargetAdapterOptions {
  readonly descriptor: TargetDiscoveryDescriptor;
  readonly organization: { readonly id: string };
  readonly tokenProvider: TargetAccessTokenProvider;
  readonly transport?: HttpTransport;
  readonly clock?: Clock;
  readonly retryPolicy?: RetryPolicy;
}
