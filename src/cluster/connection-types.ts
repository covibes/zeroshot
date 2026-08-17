import type { FrameRecord } from './frames.js';
import type { BoundedQueue } from './queue.js';
import type { ClusterMethod, SubscriptionMethod } from './generated/protocol.js';

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly requestTimeoutMs?: number;
}
export type SubscriptionKind = SubscriptionMethod;
export type SubscriptionRegistration = {
  readonly id: string;
  readonly kind: SubscriptionKind;
  readonly queue: BoundedQueue<FrameRecord>;
  overflowed: boolean;
  cancelSent: boolean;
  abortHandler?: () => void;
  abortSignal?: AbortSignal;
};
export type EstablishedSubscription<R> = {
  readonly result: R;
  readonly registration: SubscriptionRegistration;
};
export type PendingEntry = {
  readonly id: string; readonly method: ClusterMethod; readonly expectedId: string;
  readonly resolve: (value: unknown) => void; readonly reject: (reason: unknown) => void;
  readonly subscriptionKind?: SubscriptionKind; settled: boolean;
  abortHandler?: () => void; signal?: AbortSignal; timeout?: ReturnType<typeof setTimeout>;
};
