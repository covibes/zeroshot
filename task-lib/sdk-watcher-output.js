import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  formatTaskLogMarker,
  formatTaskLogStderr,
  formatTaskLogStdout,
} = require('../src/task-log-line.js');

export function markSdkTaskLog(log, timestamp = Date.now()) {
  log(formatTaskLogMarker(timestamp));
}

function normalizedTerminalEvent(terminal) {
  if (terminal.type === 'result') return terminal.event;
  return {
    type: 'result',
    success: false,
    error: { ...terminal.frame.error },
  };
}

export function logSdkTerminal(log, result, now = Date.now) {
  for (const frame of result.progress) {
    log(formatTaskLogStdout(now(), JSON.stringify(frame)));
  }
  log(formatTaskLogStdout(now(), JSON.stringify(normalizedTerminalEvent(result.terminal))));
  for (const line of (result.diagnosticStderr || '').replace(/\r/g, '').split('\n')) {
    if (line) log(formatTaskLogStderr(now(), line));
  }
}
