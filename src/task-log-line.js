'use strict';

const TASK_LOG_V2_MARKER = '[ZEROSHOT][LOG_FORMAT] channel-framed-v2';
const TASK_LOG_STDOUT_PREFIX = '[ZEROSHOT][PROVIDER_STDOUT] ';
const TASK_LOG_STDERR_PREFIX = '[ZEROSHOT][PROVIDER_STDERR] ';
const TASK_LOG_V1_MARKER = '[ZEROSHOT][LOG_FORMAT] stderr-tagged-v1';
const CONTROL_LINE =
  /^\[(?:ATTACH|CLEANUP|CRASH|DETACH|ERROR|OMP-OWNERSHIP|SDK-DIAGNOSTIC|SYSTEM)\](?:\s|$)/;

function timestampParts(line) {
  const normalized = line.replace(/\r$/, '');
  const match = /^\[(\d{13}|\d{4}-\d{2}-\d{2}T[^\]]+)\](.*)$/.exec(normalized);
  if (!match) return { content: normalized, timestamp: null };
  const rawTimestamp = match[1];
  const epochTimestamp = /^\d{13}$/.test(rawTimestamp);
  const timestamp = epochTimestamp
    ? Number.parseInt(rawTimestamp, 10)
    : new Date(rawTimestamp).getTime();
  return {
    content: match[2].trimStart(),
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
  };
}

function decodeTaskLogLine(line) {
  const { content, timestamp } = timestampParts(line);
  const common = { timestamp, timestamped: timestamp !== null };
  if (content.startsWith(TASK_LOG_STDOUT_PREFIX)) {
    return {
      ...common,
      channel: 'provider_stdout',
      content: content.slice(TASK_LOG_STDOUT_PREFIX.length),
      format: null,
      providerOutput: true,
    };
  }
  if (content.startsWith(TASK_LOG_STDERR_PREFIX)) {
    return {
      ...common,
      channel: 'provider_stderr',
      content: content.slice(TASK_LOG_STDERR_PREFIX.length),
      format: null,
      providerOutput: false,
    };
  }
  let format = null;
  if (content === TASK_LOG_V2_MARKER) format = 'channel-framed-v2';
  else if (content === TASK_LOG_V1_MARKER) format = 'stderr-tagged-v1';
  const control =
    format !== null || content.startsWith('[ZEROSHOT][FATAL] ') || CONTROL_LINE.test(content);
  return {
    ...common,
    channel: control ? 'control' : 'legacy',
    content,
    format,
    providerOutput: !control,
  };
}

function formatTaskLogMarker(timestamp) {
  return `[${timestamp}]${TASK_LOG_V2_MARKER}\n`;
}

function formatTaskLogStdout(timestamp, content) {
  return `[${timestamp}]${TASK_LOG_STDOUT_PREFIX}${content}\n`;
}

function formatTaskLogStderr(timestamp, content) {
  return `[${timestamp}]${TASK_LOG_STDERR_PREFIX}${content}\n`;
}

module.exports = {
  TASK_LOG_STDERR_PREFIX,
  TASK_LOG_STDOUT_PREFIX,
  TASK_LOG_V2_MARKER,
  decodeTaskLogLine,
  formatTaskLogMarker,
  formatTaskLogStderr,
  formatTaskLogStdout,
};
