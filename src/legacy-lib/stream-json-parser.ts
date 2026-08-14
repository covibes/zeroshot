/**
 * Provider-agnostic stream-json parser for `zeroshot logs`.
 *
 * Provider parsing is delegated to the helper-backed runtime provider facade.
 */

type ParsedEvent = Readonly<Record<string, unknown>>;
type ProviderEvent = ParsedEvent | ParsedEvent[] | null;

interface ProviderParser {
  parseEvent(line: string): ProviderEvent;
}

interface ProviderFacade {
  getProvider(name: string): ProviderParser;
  listProviders(): string[];
}

interface TaskLogDecoder {
  decodeTaskLogLine(line: string): { content: string; providerOutput: boolean };
}

// The runtime facade is maintained JavaScript; keep its original emitted require path.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { getProvider, listProviders }: ProviderFacade = require('../src/providers');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const taskLogDecoder: TaskLogDecoder = require('../src/task-log-line');
const { decodeTaskLogLine } = taskLogDecoder;

function createProviderParsers(): ProviderParser[] {
  return listProviders().map((name) => getProvider(name));
}

function stripTimestampPrefix(line: unknown): string {
  if (!line || typeof line !== 'string') return '';
  const decoded = decodeTaskLogLine(line.trim());
  if (!decoded.providerOutput) return '';
  const trimmed = decoded.content;

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const pipeMatch = /^[^|]{1,40}\|\s*(.*)$/.exec(trimmed);
    if (pipeMatch) {
      const afterPipe = (pipeMatch[1] || '').trimStart();
      if (afterPipe.startsWith('{') || afterPipe.startsWith('[')) return afterPipe;
    }
  }

  return trimmed;
}

// The provider protocol intentionally permits one event, an event batch, or no event.
// eslint-disable-next-line sonarjs/function-return-type
function parseEvent(
  line: unknown,
  providerParsers: readonly ProviderParser[] = createProviderParsers()
): ProviderEvent {
  const content = stripTimestampPrefix(line);
  let result: ProviderEvent = null;
  if (content) {
    for (const provider of providerParsers) {
      const event = provider.parseEvent(content);
      if (event) {
        result = event;
        break;
      }
    }
  }
  return result;
}

function collectEvent(events: ParsedEvent[], event: ProviderEvent): void {
  if (!event) return;
  if (Array.isArray(event)) {
    events.push(...event);
    return;
  }
  events.push(event);
}

function parseChunk(chunk: unknown): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const lines = String(chunk || '').split('\n');
  const providerParsers = createProviderParsers();

  for (const line of lines) {
    if (!line.trim()) continue;
    collectEvent(events, parseEvent(line, providerParsers));
  }

  return events;
}

export = { parseEvent, parseChunk };
