import { MAX_RETRY_ELAPSED_MS } from './bounds.js';
import { TargetAdapterError } from './errors.js';
import type { Clock, RetryPolicy } from './types.js';

export type TargetOperation = 'allocate' | 'list' | 'inspect' | 'terminate' | 'limits' | 'access';

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new globalThis.DOMException('The operation was aborted', 'AbortError');
  }
}

async function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(
          signal.reason ?? new globalThis.DOMException('The operation was aborted', 'AbortError')
        );
      },
      { once: true }
    );
  });
}

type RetryContext = {
  readonly clock: Clock;
  readonly policy: RetryPolicy;
};
function retryableError(value: unknown): value is TargetAdapterError {
  return value instanceof TargetAdapterError && value.retryable;
}

function validRetryDelay(retry: boolean, delayMs: number, remaining: number): boolean {
  return retry && Number.isFinite(delayMs) && delayMs >= 0 && delayMs < remaining;
}

export async function withTargetRetry<T>(
  operation: TargetOperation,
  effect: () => Promise<T>,
  signal: AbortSignal | undefined,
  context: RetryContext
): Promise<T> {
  const retrySafe = operation !== 'access';
  const started = context.clock.now();
  let attempt = 0;
  while (true) {
    throwIfAborted(signal);
    try {
      return await effect();
    } catch (error) {
      throwIfAborted(signal);
      if (!retrySafe || !retryableError(error)) throw error;
      attempt += 1;
      const elapsed = context.clock.now() - started;
      const decision = context.policy.shouldRetry(attempt, elapsed, error);
      const remaining = MAX_RETRY_ELAPSED_MS - elapsed;
      if (!validRetryDelay(decision.retry, decision.delayMs, remaining)) throw error;
      await wait(decision.delayMs, signal);
    }
  }
}
