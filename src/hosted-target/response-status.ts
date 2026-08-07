import { throwCapsuleServerError } from './capsule-error-response.js';
import { TargetProtocolError } from './errors.js';
import type { Clock } from './types.js';

export async function assertCapsuleResponseStatus(
  response: Response,
  expectedStatus: number,
  readJson: (response: Response) => Promise<unknown>,
  clock: Clock
): Promise<void> {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new TargetProtocolError('Capsule redirects are forbidden');
  }
  if (response.status === expectedStatus) return;
  if (response.status >= 200 && response.status < 300) {
    await response.body?.cancel().catch(() => undefined);
    throw new TargetProtocolError('Target returned an unexpected success status');
  }
  await throwCapsuleServerError(response, readJson, clock);
}
