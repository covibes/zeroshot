'use strict';

const { decodeTaskLogLine } = require('../../../src/task-log-line');

function extractTaskLogProviderOutput(rawLog, terminalType) {
  const lines = rawLog
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map(decodeTaskLogLine)
    .filter((line) => line.providerOutput)
    .map((line) => line.content);
  const start = lines.findIndex((line) => line.includes('"type":"thread.started"'));
  const end = lines.findIndex(
    (line, index) => index >= start && line.includes(`"type":"${terminalType}"`)
  );
  if (start < 0 || end < start) {
    throw new Error(`Task log does not contain a complete provider turn ending in ${terminalType}`);
  }
  return `${lines.slice(start, end + 1).join('\n')}\n`;
}

module.exports = { extractTaskLogProviderOutput };
