interface TaskLogDecoder {
  decodeTaskLogLine(line: string): { readonly content: string; readonly providerOutput: boolean };
}

// The canonical decoder is maintained JavaScript and remains at the same source path after build.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const taskLogDecoder: TaskLogDecoder = require('../../src/task-log-line');
const { decodeTaskLogLine } = taskLogDecoder;

export function stripTimestampPrefix(line: string): string {
  const decoded = decodeTaskLogLine(line.trim());
  if (!decoded.providerOutput) return '';
  let trimmed = decoded.content;
  if (!trimmed) return '';

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const pipeMatch = /^[^|]{1,40}\|\s*(.*)$/.exec(trimmed);
    const afterPipe = pipeMatch?.[1]?.trimStart();
    if (typeof afterPipe === 'string' && (afterPipe.startsWith('{') || afterPipe.startsWith('['))) {
      return afterPipe;
    }
  }

  return trimmed;
}
