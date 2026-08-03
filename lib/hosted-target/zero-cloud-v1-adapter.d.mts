import type { TargetAdapter, CreateTargetAdapterOptions } from './target-adapter.mjs';
import type { AllocateRequest, Capsule, CapsuleAccess, CapsuleLimits, CapsuleListPage, ListRequest } from './types.mjs';
export declare class ZeroCloudV1TargetAdapter implements TargetAdapter {
    #private;
    constructor(options: CreateTargetAdapterOptions);
    get credentialInstall(): TargetAdapter['credentialInstall'];
    allocate(request: AllocateRequest, signal?: AbortSignal): Promise<Capsule>;
    list(request?: ListRequest, signal?: AbortSignal): Promise<CapsuleListPage>;
    inspect(capsuleId: string, signal?: AbortSignal): Promise<Capsule>;
    terminate(capsuleId: string, signal?: AbortSignal): Promise<Capsule>;
    limits(signal?: AbortSignal): Promise<CapsuleLimits>;
    access(capsuleId: string, signal?: AbortSignal): Promise<CapsuleAccess>;
}
