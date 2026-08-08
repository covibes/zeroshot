import type { CredentialInstallDescriptor } from '../target/discovery.js';
import { readBoundedResponseJson } from '../target/bounded-response.js';
import { MAX_RESPONSE_BYTES } from './bounds.js';
import { TargetProtocolError } from './errors.js';
import { assertCapsuleResponseStatus } from './response-status.js';
import { withTargetRetry } from './retry-executor.js';
import type { Clock, RetryPolicy } from './types.js';

type RuntimeInstallOptions = {
  readonly capsuleId: string;
  readonly runtime: unknown;
  readonly accessToken: string;
  readonly descriptor: CredentialInstallDescriptor;
  readonly signal?: AbortSignal;
  readonly clock: Clock;
  readonly retryPolicy: RetryPolicy;
  readonly request: (
    method: string,
    path: string,
    signal: AbortSignal | undefined,
    body: string,
    accessToken: string
  ) => Promise<Response>;
};

function validOpaque(value: string, field: string): void {
  if (value.length === 0 || value.length > 1024) {
    throw new TargetProtocolError(`${field} is invalid`);
  }
}

function runtimeBody(runtime: unknown, maximum: number): string {
  let body: string | undefined;
  try {
    body = JSON.stringify(runtime);
  } catch {
    throw new TargetProtocolError('Runtime bundle is not serializable');
  }
  if (body === undefined || Buffer.byteLength(body) > maximum) {
    throw new TargetProtocolError('Runtime bundle exceeds the advertised size bound');
  }
  return body;
}

export async function installRuntime(options: RuntimeInstallOptions): Promise<void> {
  validOpaque(options.capsuleId, 'capsule id');
  validOpaque(options.accessToken, 'capsule access token');
  let path: string;
  try {
    path = options.descriptor.install.routeTemplate.expand({
      capsule_id: options.capsuleId,
    });
  } catch {
    throw new TargetProtocolError('Runtime install route expansion is unsafe');
  }
  const body = runtimeBody(options.runtime, options.descriptor.maxBodyBytes);
  await withTargetRetry(
    'installRuntime',
    async () => {
      const response = await options.request(
        options.descriptor.install.method,
        path,
        options.signal,
        body,
        options.accessToken
      );
      await assertCapsuleResponseStatus(
        response,
        204,
        (errorResponse) =>
          readBoundedResponseJson(
            errorResponse,
            MAX_RESPONSE_BYTES,
            () => new TargetProtocolError('Capsule error response is malformed')
          ),
        options.clock
      );
      await response.body?.cancel().catch(() => undefined);
    },
    options.signal,
    { clock: options.clock, policy: options.retryPolicy }
  );
}
