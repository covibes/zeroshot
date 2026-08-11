const TASK_STARTUP_ERROR_PREFIX = 'ZEROSHOT_TASK_STARTUP_ERROR:';
const SUPPORTED_STARTUP_ERROR_CODES = new Set<string>(['unsupported-capability']);

type TaskStartupErrorCode = 'unsupported-capability';

interface TaskStartupErrorFields {
  version?: unknown;
  code?: unknown;
  permanent?: unknown;
  message?: unknown;
  provider?: unknown;
  capability?: unknown;
}

interface TaskStartupError extends Error {
  code: TaskStartupErrorCode;
  permanent: true;
  provider?: string;
  capability?: string;
}

interface TaskStartupErrorMetadata {
  code: TaskStartupErrorCode;
  permanent: true;
  provider?: string;
  capability?: string;
}

interface SerializedTaskStartupError {
  version: 1;
  code: TaskStartupErrorCode;
  permanent: true;
  message: string;
  provider?: string;
  capability?: string;
}

function hasTaskStartupErrorFields(value: unknown): value is TaskStartupErrorFields {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function isTaskStartupErrorCode(value: unknown): value is TaskStartupErrorCode {
  return typeof value === 'string' && SUPPORTED_STARTUP_ERROR_CODES.has(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isSerializedTaskStartupError(value: unknown): value is SerializedTaskStartupError {
  return Boolean(
    hasTaskStartupErrorFields(value) &&
    value.version === 1 &&
    isTaskStartupErrorCode(value.code) &&
    value.permanent === true &&
    typeof value.message === 'string' &&
    value.message.length > 0 &&
    isOptionalString(value.provider) &&
    isOptionalString(value.capability)
  );
}

function createUnsupportedProviderCapabilityError(
  provider: string,
  capability: string,
  message: string
): TaskStartupError {
  const error = new Error(message);
  error.name = 'UnsupportedProviderCapabilityError';
  const metadata: TaskStartupErrorMetadata = {
    code: 'unsupported-capability',
    permanent: true,
    provider,
    capability,
  };
  return Object.assign(error, metadata);
}

function serializeTaskStartupError(error: unknown): string | null {
  if (
    !hasTaskStartupErrorFields(error) ||
    !isTaskStartupErrorCode(error.code) ||
    error.permanent !== true
  ) {
    return null;
  }
  const payload: SerializedTaskStartupError = {
    version: 1,
    code: error.code,
    permanent: true,
    message: String(error.message || error.code),
  };
  if (typeof error.provider === 'string') payload.provider = error.provider;
  if (typeof error.capability === 'string') payload.capability = error.capability;
  return `${TASK_STARTUP_ERROR_PREFIX}${JSON.stringify(payload)}`;
}

function parseTaskStartupError(stderr: unknown): TaskStartupError | null {
  const lines = String(stderr || '').split(/\r?\n/);
  let line = lines.pop();
  while (line === '' && lines.length > 0) line = lines.pop();
  if (!line?.startsWith(TASK_STARTUP_ERROR_PREFIX)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(TASK_STARTUP_ERROR_PREFIX.length));
  } catch {
    return null;
  }
  if (!isSerializedTaskStartupError(parsed)) return null;

  const metadata: TaskStartupErrorMetadata = {
    code: parsed.code,
    permanent: true,
  };
  if (parsed.provider !== undefined) metadata.provider = parsed.provider;
  if (parsed.capability !== undefined) metadata.capability = parsed.capability;
  return Object.assign(new Error(parsed.message), metadata);
}

export = {
  TASK_STARTUP_ERROR_PREFIX,
  createUnsupportedProviderCapabilityError,
  parseTaskStartupError,
  serializeTaskStartupError,
};
