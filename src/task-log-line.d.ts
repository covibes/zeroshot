export const TASK_LOG_V2_MARKER: '[ZEROSHOT][LOG_FORMAT] channel-framed-v2';
export const TASK_LOG_STDOUT_PREFIX: '[ZEROSHOT][PROVIDER_STDOUT] ';
export const TASK_LOG_STDERR_PREFIX: '[ZEROSHOT][PROVIDER_STDERR] ';

export type TaskLogChannel = 'provider_stdout' | 'provider_stderr' | 'control' | 'legacy';
export type TaskLogFormat = 'stderr-tagged-v1' | 'channel-framed-v2' | null;

export interface DecodedTaskLogLine {
  readonly channel: TaskLogChannel;
  readonly content: string;
  readonly format: TaskLogFormat;
  readonly providerOutput: boolean;
  readonly timestamp: number | null;
  readonly timestamped: boolean;
}

export function decodeTaskLogLine(line: string): DecodedTaskLogLine;
export function formatTaskLogMarker(timestamp: number): string;
export function formatTaskLogStderr(timestamp: number, content: string): string;
export function formatTaskLogStdout(timestamp: number, content: string): string;
