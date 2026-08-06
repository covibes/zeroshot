import { closeSync, readSync } from 'node:fs';
import { TextDecoder } from 'node:util';

import { OMP_SDK_MAX_CREDENTIAL_BYTES, type OmpSdkSidecarRequest } from './sdk-protocol';
import {
  CREDENTIAL_NAME,
  MAX_CREDENTIAL_COUNT,
  MAX_CREDENTIAL_NAME_BYTES,
  MAX_CREDENTIAL_VALUE_BYTES,
  SidecarFailure,
  isRecord,
  type CredentialChannel,
} from './sdk-sidecar-types';

function closeCredentialChannel(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    throw new SidecarFailure('invalid-request', 'request', false);
  }
}
export function readCredentialChannel(fd: number): CredentialChannel {
  if (!Number.isInteger(fd) || fd < 3) {
    throw new SidecarFailure('invalid-request', 'request', false);
  }
  const buffer = Buffer.allocUnsafe(OMP_SDK_MAX_CREDENTIAL_BYTES + 1);
  let offset = 0;
  try {
    while (offset <= OMP_SDK_MAX_CREDENTIAL_BYTES) {
      const count = readSync(fd, buffer, offset, buffer.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
  } catch {
    throw new SidecarFailure('invalid-request', 'request', false);
  } finally {
    closeCredentialChannel(fd);
  }
  if (offset === 0 || offset > OMP_SDK_MAX_CREDENTIAL_BYTES) {
    throw new SidecarFailure('invalid-request', 'request', false);
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
    parsed = JSON.parse(text);
  } catch {
    throw new SidecarFailure('invalid-request', 'request', false);
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 2 ||
    parsed.protocolVersion !== 1 ||
    !isRecord(parsed.values)
  ) {
    throw new SidecarFailure('invalid-request', 'request', false);
  }
  const entries = Object.entries(parsed.values);
  if (entries.length > MAX_CREDENTIAL_COUNT) {
    throw new SidecarFailure('invalid-request', 'request', false);
  }
  const values: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (
      !CREDENTIAL_NAME.test(name) ||
      Buffer.byteLength(name) > MAX_CREDENTIAL_NAME_BYTES ||
      typeof value !== 'string' ||
      value.length === 0 ||
      Buffer.byteLength(value) > MAX_CREDENTIAL_VALUE_BYTES
    ) {
      throw new SidecarFailure('invalid-request', 'request', false);
    }
    values[name] = value;
  }
  return { values: Object.freeze(values) };
}
export function credentialsForRequest(
  request: OmpSdkSidecarRequest,
  channel: CredentialChannel
): CredentialChannel {
  const provider = request.modelSelector.slice(0, request.modelSelector.indexOf('/'));
  let expected: readonly string[];
  if (request.auth.mode === 'environment') {
    const reference = request.auth.credentials[provider];
    if (reference === undefined) throw new SidecarFailure('provider-auth', 'auth', false);
    expected = [reference.env];
  } else if (request.auth.mode === 'broker') {
    expected = ['OMP_AUTH_BROKER_TOKEN', 'OMP_AUTH_BROKER_URL'];
  } else {
    expected = [];
  }
  const actual = Object.keys(channel.values).sort((left, right) => left.localeCompare(right));
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right));
  if (
    actual.length !== sortedExpected.length ||
    actual.some((name, index) => name !== sortedExpected[index])
  ) {
    throw new SidecarFailure('provider-auth', 'auth', false);
  }
  return channel;
}
