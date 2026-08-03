import type {
  RetryPolicy,
  TargetAccessTokenProvider,
} from '../helpers/hosted-target-runtime.mjs';
import { makeDiscovery } from '../target/harness.mjs';
export { FakeHttpTransport } from '../target/harness.mjs';


export class FakeTokenProvider implements TargetAccessTokenProvider {
  readonly calls: Array<AbortSignal | undefined> = [];
  readonly token: string;
  constructor(token = 'admin-access-canary') {
    this.token = token;
  }
  async getAccessToken(signal?: AbortSignal): Promise<string> {
    this.calls.push(signal);
    return this.token;
  }
}

export function fakeDiscovery() {
  return makeDiscovery('https://hosted.openengine.example');
}

export function capsule(id = 'cap-1', state = 'ready') {
  return { capsule_id: id, state, label: null, created_at: '2026-08-03T00:00:00Z' };
}

export const NO_RETRY: RetryPolicy = {
  shouldRetry: () => ({ retry: false, delayMs: 0 }),
};
