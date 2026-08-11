import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getString, isRecord, tryParseJson } from '../json';

export const STREAMING_MODE_ERROR = 'only prompt commands are supported in streaming mode';
export const NO_MESSAGES_RETURNED = 'No messages returned';

export interface StreamingModeError {
  readonly sessionId: string;
  readonly line: string;
}

export interface StructuredOutputRecovery {
  readonly payload: Record<string, unknown>;
  readonly sourcePath: string;
}

export function detectProviderStreamingModeError(
  provider: string,
  line: unknown
): StreamingModeError | null {
  if (!isClaudeProvider(provider)) return null;
  return detectClaudeStreamingModeError(line);
}

export function detectProviderFatalError(provider: string, line: unknown): string | null {
  if (isClaudeProvider(provider)) return detectClaudeFatalError(line);
  if (provider.toLowerCase() === 'pi') return detectPiFatalError(line);
  return null;
}

export function recoverProviderStructuredOutput(
  provider: string,
  sessionId: string
): StructuredOutputRecovery | null {
  if (!isClaudeProvider(provider)) return null;
  return recoverClaudeStructuredOutput(sessionId);
}

export function supportsProviderStructuredOutputRecovery(provider: string): boolean {
  return isClaudeProvider(provider);
}

function isClaudeProvider(provider: string): boolean {
  const normalized = provider.toLowerCase();
  return normalized === 'claude' || normalized === 'anthropic';
}

function detectClaudeStreamingModeError(line: unknown): StreamingModeError | null {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  if (!trimmed.startsWith('{')) return null;

  const parsed = tryParseJson(trimmed);
  if (
    isRecord(parsed) &&
    parsed.type === 'result' &&
    parsed.is_error === true &&
    Array.isArray(parsed.errors) &&
    parsed.errors.includes(STREAMING_MODE_ERROR) &&
    typeof parsed.session_id === 'string'
  ) {
    return {
      sessionId: parsed.session_id,
      line: trimmed,
    };
  }

  return null;
}

function detectClaudeFatalError(line: unknown): string | null {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{') && tryParseJson(trimmed) !== null) {
    return null;
  }

  if (trimmed.toLowerCase().includes(NO_MESSAGES_RETURNED.toLowerCase())) {
    return `Claude CLI error: ${NO_MESSAGES_RETURNED}`;
  }

  return null;
}

function detectPiFatalError(line: unknown): string | null {
  if (typeof line !== 'string') return null;
  const message = line.trim();
  if (/\bno api key found\b/i.test(message)) {
    return 'Pi authentication required: run /login';
  }
  if (/\bmodel\b.*\bnot found\b/i.test(message)) {
    return 'Pi model not found: run pi --list-models';
  }
  return null;
}

function findSessionJsonlPath(sessionId: string): string | null {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const projectsDir = join(claudeDir, 'projects');
  if (!existsSync(projectsDir)) return null;

  const target = `${sessionId}.jsonl`;
  const queue: string[] = [projectsDir];

  while (queue.length > 0) {
    const dir = queue.pop();
    if (dir === undefined) continue;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name === target) {
        return join(dir, entry.name);
      }
      if (entry.isDirectory()) {
        queue.push(join(dir, entry.name));
      }
    }
  }

  return null;
}

function recoverClaudeStructuredOutput(sessionId: string): StructuredOutputRecovery | null {
  const jsonlPath = findSessionJsonlPath(sessionId);
  if (jsonlPath === null) return null;

  const fileContents = readJsonlFile(jsonlPath);
  if (fileContents === null) return null;

  const { structuredOutput, usage } = findStructuredOutput(fileContents);
  if (structuredOutput === null) return null;

  return {
    payload: buildStructuredOutputPayload(sessionId, structuredOutput, usage),
    sourcePath: jsonlPath,
  };
}

function readJsonlFile(jsonlPath: string): string | null {
  try {
    return readFileSync(jsonlPath, 'utf8');
  } catch {
    return null;
  }
}

function findStructuredOutput(fileContents: string): {
  readonly structuredOutput: Record<string, unknown> | null;
  readonly usage: Record<string, unknown> | null;
} {
  const lines = fileContents.split('\n');
  let structuredOutput: Record<string, unknown> | null = null;
  let usage: Record<string, unknown> | null = null;

  for (const line of lines) {
    const entry = tryParseJson(line);
    if (!isRecord(entry)) continue;

    const extracted = extractStructuredOutputFromEntry(entry);
    if (extracted !== null) {
      structuredOutput = extracted.structuredOutput;
      usage = extracted.usage;
    }
  }

  return { structuredOutput, usage };
}

function extractStructuredOutputFromEntry(entry: Record<string, unknown>): {
  readonly structuredOutput: Record<string, unknown>;
  readonly usage: Record<string, unknown> | null;
} | null {
  const message = entry.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return null;

  let structuredOutput: Record<string, unknown> | null = null;
  let usage: Record<string, unknown> | null = null;
  for (const block of message.content) {
    if (
      isRecord(block) &&
      getString(block, 'type') === 'tool_use' &&
      getString(block, 'name') === 'StructuredOutput' &&
      isRecord(block.input)
    ) {
      structuredOutput = block.input;
      usage = isRecord(message.usage) ? message.usage : null;
    }
  }

  if (structuredOutput === null) return null;
  return { structuredOutput, usage };
}

function buildStructuredOutputPayload(
  sessionId: string,
  structuredOutput: Record<string, unknown>,
  usage: Record<string, unknown> | null
): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: structuredOutput,
    session_id: sessionId,
    ...(usage === null ? {} : { usage }),
  };
}
