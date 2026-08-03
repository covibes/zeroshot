import type { AllocateRequest, Capsule, CapsuleAccess, CapsuleLimits, CapsuleListPage } from './types.ts';

export interface TargetAdapter {
  allocate(req: AllocateRequest, signal?: AbortSignal): Promise<Capsule>;
  list(cursor?: string, signal?: AbortSignal): Promise<CapsuleListPage>;
  inspect(capsuleId: string, signal?: AbortSignal): Promise<Capsule>;
  terminate(capsuleId: string, signal?: AbortSignal): Promise<void>;
  limits(signal?: AbortSignal): Promise<CapsuleLimits>;
  access(capsuleId: string, signal?: AbortSignal): Promise<CapsuleAccess>;
}
