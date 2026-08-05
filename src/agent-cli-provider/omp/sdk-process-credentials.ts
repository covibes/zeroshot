import { OMP_SDK_MAX_CREDENTIAL_BYTES } from './sdk-protocol';
import { OmpSdkProcessRunnerError } from './sdk-process-error';

const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_CREDENTIAL_COUNT = 32;
const MAX_CREDENTIAL_NAME_BYTES = 128;
const MAX_CREDENTIAL_VALUE_BYTES = 16 * 1024;

export function credentialPayload(
  names: readonly string[],
  source: Readonly<Record<string, string | undefined>>
): { readonly payload: Buffer; readonly secretValues: readonly string[] } {
  if (names.length > MAX_CREDENTIAL_COUNT || new Set(names).size !== names.length) {
    throw new OmpSdkProcessRunnerError(
      'credential-error',
      'OMP SDK credential name set is invalid.'
    );
  }
  const values: Record<string, string> = {};
  const secretValues: string[] = [];
  for (const name of names) {
    const value = source[name];
    if (
      !CREDENTIAL_NAME.test(name) ||
      Buffer.byteLength(name) > MAX_CREDENTIAL_NAME_BYTES ||
      typeof value !== 'string' ||
      value.length === 0 ||
      Buffer.byteLength(value) > MAX_CREDENTIAL_VALUE_BYTES
    ) {
      throw new OmpSdkProcessRunnerError(
        'credential-error',
        `OMP SDK credential ${name} is missing or invalid.`
      );
    }
    values[name] = value;
    secretValues.push(value);
  }
  const payload = Buffer.from(JSON.stringify({ protocolVersion: 1, values }), 'utf8');
  if (payload.byteLength > OMP_SDK_MAX_CREDENTIAL_BYTES) {
    payload.fill(0);
    throw new OmpSdkProcessRunnerError(
      'credential-error',
      'OMP SDK credential document is oversized.'
    );
  }
  return { payload, secretValues };
}

export function redactDiagnostic(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}
