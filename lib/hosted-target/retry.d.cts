import type { TargetAdapterError } from './errors.js';
import type { Clock, RetryPolicy } from './types.js';
export declare class DefaultRetryPolicy implements RetryPolicy {
    shouldRetry(attempt: number, elapsed: number, error: TargetAdapterError): {
        retry: boolean;
        delayMs: number;
    };
}
export declare function parseRetryAfter(header: string | null, clock: Clock): number | null;
