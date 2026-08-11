import crypto = require('crypto');
import fs = require('fs');
import os = require('os');
import path = require('path');

interface SettingsRecord extends Record<string, unknown> {
  autoCheckUpdates?: unknown;
  lastUpdateCheckClaim?: unknown;
  updatePolicy?: unknown;
}

interface DefaultsFacade {
  resolvedDefaultSettings(): SettingsRecord;
  mergeLoadedSettings(parsed: SettingsRecord): SettingsRecord;
}

interface LockOptions {
  lockfilePath: string;
  realpath: boolean;
  stale: number;
}

interface LockfileFacade {
  lockSync(settingsFile: string, options: LockOptions): ReleaseLock;
}

interface LoadOptions {
  silent?: unknown;
}

interface MutationOptions {
  lockTimeoutMs?: number;
}

interface MutationState {
  settings: SettingsRecord;
  requiresClaimInvalidation: boolean;
  requiresRecovery: boolean;
}

type SettingsMutator = (settings: SettingsRecord) => unknown;
type ReleaseLock = () => void;

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const lockfile: LockfileFacade = require('proper-lockfile');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const defaults: DefaultsFacade = require('./settings-defaults');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { SettingsValidationError }: { SettingsValidationError: typeof Error } =
  require('./settings-error');

const { resolvedDefaultSettings, mergeLoadedSettings } = defaults;
const SETTINGS_LOCK_STALE_MS = 5000;
const SETTINGS_LOCK_TIMEOUT_MS = 500;
const SETTINGS_LOCK_RETRY_MS = 20;
const SETTINGS_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function isSettingsRecord(value: unknown): value is SettingsRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function getSettingsFile(): string {
  return (
    process.env.ZEROSHOT_SETTINGS_FILE || path.join(os.homedir(), '.zeroshot', 'settings.json')
  );
}

function settingsFileExists(): boolean {
  return fs.existsSync(getSettingsFile());
}

function loadSettings(options: LoadOptions = {}): SettingsRecord {
  const settingsFile = getSettingsFile();
  if (!fs.existsSync(settingsFile)) {
    return resolvedDefaultSettings();
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (!isSettingsRecord(parsed)) {
      throw new TypeError('settings file must contain an object');
    }
    return mergeLoadedSettings(parsed);
  } catch {
    if (!options.silent) console.error('Warning: Could not load settings, using defaults');
    return resolvedDefaultSettings();
  }
}

function readSettingsForMutation(settingsFile: string): MutationState {
  if (!fs.existsSync(settingsFile)) {
    return {
      settings: resolvedDefaultSettings(),
      requiresClaimInvalidation: false,
      requiresRecovery: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return {
      settings: resolvedDefaultSettings(),
      requiresClaimInvalidation: false,
      requiresRecovery: true,
    };
  }
  if (!isSettingsRecord(parsed)) {
    return {
      settings: resolvedDefaultSettings(),
      requiresClaimInvalidation: false,
      requiresRecovery: true,
    };
  }

  const updatesDisabled = parsed.autoCheckUpdates === false || parsed.updatePolicy === 'off';
  return {
    settings: mergeLoadedSettings(parsed),
    requiresClaimInvalidation: updatesDisabled && parsed.lastUpdateCheckClaim !== null,
    requiresRecovery: false,
  };
}

function getAtomicSettingsMode(settingsFile: string): number {
  try {
    return fs.statSync(settingsFile).mode & 0o600;
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return 0o600;
    throw error;
  }
}

function atomicWriteSettings(settingsFile: string, settings: SettingsRecord): void {
  const dir = path.dirname(settingsFile);
  const temporaryFile = path.join(
    dir,
    `.${path.basename(settingsFile)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );

  let operationError: unknown;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(settings, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: getAtomicSettingsMode(settingsFile),
    });
    fs.renameSync(temporaryFile, settingsFile);
  } catch (error: unknown) {
    operationError = error;
  }

  try {
    fs.unlinkSync(temporaryFile);
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT' && !operationError) operationError = error;
  }
  if (operationError) throw operationError;
}

function acquireSettingsLock(
  settingsFile: string,
  lockfilePath: string,
  timeoutMs: number
): ReleaseLock {
  const deadline = Date.now() + timeoutMs;
  return tryAcquireSettingsLock(settingsFile, lockfilePath, deadline);
}

function shouldRetrySettingsLock(error: unknown, deadline: number): boolean {
  return errorCode(error) === 'ELOCKED' && Date.now() < deadline;
}

function tryAcquireSettingsLock(
  settingsFile: string,
  lockfilePath: string,
  deadline: number
): ReleaseLock {
  try {
    return lockfile.lockSync(settingsFile, {
      lockfilePath,
      realpath: false,
      stale: SETTINGS_LOCK_STALE_MS,
    });
  } catch (error: unknown) {
    if (!shouldRetrySettingsLock(error, deadline)) throw error;
    Atomics.wait(SETTINGS_LOCK_SLEEP, 0, 0, SETTINGS_LOCK_RETRY_MS);
    return tryAcquireSettingsLock(settingsFile, lockfilePath, deadline);
  }
}

function applySettingsMutation(settingsFile: string, mutator: SettingsMutator): unknown {
  const { settings, requiresClaimInvalidation, requiresRecovery } =
    readSettingsForMutation(settingsFile);
  const before = JSON.stringify(settings);
  const result = mutator(settings);
  if (isPromiseLike(result)) {
    throw new TypeError('Global settings mutations must be synchronous');
  }
  if (settings.autoCheckUpdates === false || settings.updatePolicy === 'off') {
    settings.lastUpdateCheckClaim = null;
  }
  if (requiresRecovery || requiresClaimInvalidation || JSON.stringify(settings) !== before) {
    atomicWriteSettings(settingsFile, settings);
  }
  return result;
}

function asMutationError(error: unknown): Error {
  return error instanceof SettingsValidationError
    ? error
    : new Error(`Unable to persist global settings: ${errorMessage(error)}`, { cause: error });
}

function releaseSettingsLock(
  release: ReleaseLock | undefined,
  mutationError: Error | undefined
): Error | undefined {
  if (!release) return mutationError;
  try {
    release();
    return mutationError;
  } catch (error: unknown) {
    return (
      mutationError ||
      new Error(`Unable to release global settings lock: ${errorMessage(error)}`, { cause: error })
    );
  }
}

function mutateSettings(mutator: SettingsMutator, options: MutationOptions = {}): unknown {
  if (typeof mutator !== 'function') {
    throw new TypeError('Global settings mutation requires a callback');
  }

  const settingsFile = getSettingsFile();
  const dir = path.dirname(settingsFile);
  const lockfilePath = `${settingsFile}.lock`;
  let release: ReleaseLock | undefined;
  let result: unknown;
  let mutationError: Error | undefined;

  try {
    fs.mkdirSync(dir, { recursive: true });
    release = acquireSettingsLock(
      settingsFile,
      lockfilePath,
      options.lockTimeoutMs ?? SETTINGS_LOCK_TIMEOUT_MS
    );

    result = applySettingsMutation(settingsFile, mutator);
  } catch (error: unknown) {
    mutationError = asMutationError(error);
  } finally {
    mutationError = releaseSettingsLock(release, mutationError);
  }
  if (mutationError) throw mutationError;
  return result;
}

export = { loadSettings, mutateSettings, getSettingsFile, settingsFileExists };
