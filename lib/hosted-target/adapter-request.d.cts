import type { RouteTemplate, TargetDiscoveryDescriptor } from '../target/discovery.js';
import type { TargetOperation } from './retry-executor.js';
export type AdapterRequest = {
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
};
export type ExecuteArguments<T> = [
    operation: TargetOperation,
    method: string,
    template: RouteTemplate,
    values: Readonly<Record<string, string | number | undefined>>,
    expectedStatus: number,
    validate: (body: unknown) => T,
    signal?: AbortSignal,
    request?: AdapterRequest
];
export declare function requestUrl(path: string, descriptor: TargetDiscoveryDescriptor): URL;
