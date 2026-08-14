interface TextEvent {
  readonly type: 'text' | 'thinking';
  readonly text: string;
}

interface ToolCallEvent {
  readonly type: 'tool_call';
  readonly toolName: string | null | undefined;
  readonly toolId: string | null | undefined;
  readonly input: unknown;
}

interface ToolResultEvent {
  readonly type: 'tool_result';
  readonly toolId: string | null | undefined;
  readonly content: unknown;
  readonly isError: unknown;
}

interface ResultEvent {
  readonly type: 'result';
  readonly success: boolean;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly cost?: unknown;
  readonly duration?: unknown;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly modelUsage?: unknown;
  readonly requests?: number;
  readonly usageSource?: unknown;
  readonly usageCompleteness?: unknown;
  readonly invocation?: unknown;
  readonly ompSdk?: unknown;
}

export type OutputEvent = TextEvent | ToolCallEvent | ToolResultEvent | ResultEvent;
export type ProviderParseResult = OutputEvent | readonly OutputEvent[] | null;

export interface ProviderAdapter {
  readonly id: string;
  readonly adapterVersion: string;
  createParserState(): object;
  parseEvent(line: string, state: object): ProviderParseResult;
  finishParsing?(state: object): ProviderParseResult;
}

interface AdapterRuntime {
  getProviderAdapter(provider: string): ProviderAdapter;
}

interface PrefixRuntime {
  stripTimestampPrefix(line: string): string;
}

function isRuntime(value: unknown, method: string): boolean {
  return (
    value !== null && typeof value === 'object' && typeof Reflect.get(value, method) === 'function'
  );
}

function isAdapterRuntime(value: unknown): value is AdapterRuntime {
  return isRuntime(value, 'getProviderAdapter');
}

function isPrefixRuntime(value: unknown): value is PrefixRuntime {
  return isRuntime(value, 'stripTimestampPrefix');
}

const adapters: unknown = require('../lib/agent-cli-provider/adapters');
const prefixes: unknown = require('../lib/agent-cli-provider/log-prefix');
if (!isAdapterRuntime(adapters) || !isPrefixRuntime(prefixes)) {
  throw new Error('Built agent-provider runtime is unavailable');
}

export const getProviderAdapter = adapters.getProviderAdapter;
export const stripTimestampPrefix = prefixes.stripTimestampPrefix;
