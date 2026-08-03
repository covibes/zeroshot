import type { Clock, RetryPolicy } from './types.js';
export type TargetOperation = 'allocate' | 'list' | 'inspect' | 'terminate' | 'limits' | 'access';
type RetryContext = {
    readonly clock: Clock;
    readonly policy: RetryPolicy;
};
export declare function withTargetRetry<T>(operation: TargetOperation, effect: () => Promise<T>, signal: AbortSignal | undefined, context: RetryContext): Promise<T>;
export {};
