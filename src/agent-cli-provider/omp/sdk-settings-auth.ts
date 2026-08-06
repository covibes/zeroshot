import * as path from 'node:path';

import { invalidField } from '../contract-errors';
import { isRecord } from '../json';
import { ENV_NAME } from './sdk-settings-constants';
import type { OmpSdkAuth, OmpSettingsValidationContext } from './sdk-settings-types';
import { assertProviderId, enumValue, rejectUnknown } from './sdk-settings-values';

export function normalizeAuth(value: unknown, context: OmpSettingsValidationContext): OmpSdkAuth {
  if (!isRecord(value)) {
    invalidField('providerSettings.omp.auth', 'OMP auth must be a discriminated object.');
  }
  const mode = enumValue(
    value.mode,
    ['environment', 'broker', 'omp-home', 'none'] as const,
    'providerSettings.omp.auth.mode'
  );
  if (mode === 'environment') {
    rejectUnknown(value, new Set(['mode', 'credentials']), 'providerSettings.omp.auth');
    if (!isRecord(value.credentials) || Object.keys(value.credentials).length === 0) {
      invalidField(
        'providerSettings.omp.auth.credentials',
        'Environment auth requires at least one provider credential reference.'
      );
    }
    const credentials: Record<string, { env: string }> = {};
    for (const [provider, credential] of Object.entries(value.credentials)) {
      assertProviderId(provider, `providerSettings.omp.auth.credentials.${provider}`);
      if (!isRecord(credential)) {
        invalidField(
          `providerSettings.omp.auth.credentials.${provider}`,
          'Provider credential references must be objects.'
        );
      }
      rejectUnknown(
        credential,
        new Set(['env']),
        `providerSettings.omp.auth.credentials.${provider}`
      );
      if (typeof credential.env !== 'string' || !ENV_NAME.test(credential.env)) {
        invalidField(
          `providerSettings.omp.auth.credentials.${provider}.env`,
          'Credential references must contain only a valid environment variable name.'
        );
      }
      credentials[provider] = { env: credential.env };
    }
    return { mode, credentials };
  }
  if (mode === 'broker') {
    rejectUnknown(value, new Set(['mode']), 'providerSettings.omp.auth');
    return { mode };
  }
  if (mode === 'none') {
    rejectUnknown(value, new Set(['mode']), 'providerSettings.omp.auth');
    return { mode };
  }

  rejectUnknown(value, new Set(['mode', 'path']), 'providerSettings.omp.auth');
  if (context.executionContext !== undefined && context.executionContext !== 'host') {
    invalidField(
      'providerSettings.omp.auth.mode',
      'omp-home authentication is local host-only and forbidden for detached or Docker execution.'
    );
  }
  if (
    typeof value.path !== 'string' ||
    !path.isAbsolute(value.path) ||
    value.path.includes('\0') ||
    value.path.trim() !== value.path
  ) {
    invalidField(
      'providerSettings.omp.auth.path',
      'omp-home authentication requires an explicit absolute local path.'
    );
  }
  return { mode, path: path.normalize(value.path) };
}
