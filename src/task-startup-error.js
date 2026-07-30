const TASK_STARTUP_ERROR_PREFIX = 'ZEROSHOT_TASK_STARTUP_ERROR:';
const SUPPORTED_STARTUP_ERROR_CODES = new Set(['unsupported-capability']);

function serializeTaskStartupError(error) {
  if (
    !SUPPORTED_STARTUP_ERROR_CODES.has(error?.code) ||
    error?.permanent !== true
  ) {
    return null;
  }
  const payload = {
    version: 1,
    code: error.code,
    permanent: true,
    message: String(error.message || error.code),
  };
  if (typeof error.provider === 'string') payload.provider = error.provider;
  if (typeof error.capability === 'string') payload.capability = error.capability;
  return `${TASK_STARTUP_ERROR_PREFIX}${JSON.stringify(payload)}`;
}

function parseTaskStartupError(stderr) {
  const lines = String(stderr || '').split(/\r?\n/);
  let line = lines.pop();
  while (line === '' && lines.length > 0) line = lines.pop();
  if (!line?.startsWith(TASK_STARTUP_ERROR_PREFIX)) return null;

  let parsed;
  try {
    parsed = JSON.parse(line.slice(TASK_STARTUP_ERROR_PREFIX.length));
  } catch {
    return null;
  }
  if (
    parsed?.version !== 1 ||
    !SUPPORTED_STARTUP_ERROR_CODES.has(parsed.code) ||
    parsed.permanent !== true ||
    typeof parsed.message !== 'string' ||
    parsed.message.length === 0 ||
    (parsed.provider !== undefined && typeof parsed.provider !== 'string') ||
    (parsed.capability !== undefined && typeof parsed.capability !== 'string')
  ) {
    return null;
  }
  const error = new Error(parsed.message);
  error.code = parsed.code;
  error.permanent = true;
  if (parsed.provider !== undefined) error.provider = parsed.provider;
  if (parsed.capability !== undefined) error.capability = parsed.capability;
  return error;
}

module.exports = {
  TASK_STARTUP_ERROR_PREFIX,
  parseTaskStartupError,
  serializeTaskStartupError,
};
