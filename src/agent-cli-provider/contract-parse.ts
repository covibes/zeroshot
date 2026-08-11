import { parseProviderChunk } from './adapters';
import { envRedactions } from './contract-env';
import { optionalString } from './contract-errors';
import { successEnvelope, type ContractEnvelope, type ContractEvidence } from './contract-envelope';
import { adapterForProvider, type RequestData } from './contract-support';
import { tryParseJson, unknownToMessage } from './json';
import type { OutputEvent, ProviderAdapter } from './types';

function parseFragments(record: Record<string, unknown>): {
  readonly chunk: string;
  readonly sources: readonly { readonly name: string; readonly value: string }[];
} {
  const sources = ['stdout', 'stderr', 'jsonl']
    .map((name) => {
      const value = optionalString(record, name);
      return value === undefined ? null : { name, value };
    })
    .filter((value): value is { readonly name: string; readonly value: string } => value !== null);
  return {
    chunk: sources.map((source) => source.value).join('\n'),
    sources,
  };
}

function collectParseDiagnostics(
  sources: readonly { readonly name: string; readonly value: string }[]
): readonly ContractEvidence[] {
  const diagnostics: ContractEvidence[] = [];
  for (const source of sources) {
    collectSourceDiagnostics(diagnostics, source);
  }
  return diagnostics;
}

function collectSourceDiagnostics(
  diagnostics: ContractEvidence[],
  source: { readonly name: string; readonly value: string }
): void {
  const lines = source.value.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!isMalformedJsonCandidate(line)) continue;
    diagnostics.push({
      kind: 'parse-error',
      source: source.name,
      line: index + 1,
      fragment: line,
    });
  }
}

function isMalformedJsonCandidate(line: string): boolean {
  if (!line || (!line.startsWith('{') && !line.startsWith('['))) return false;
  return tryParseJson(line) === null;
}

export function parseOutputEvents(
  adapter: ProviderAdapter,
  fragments: {
    readonly chunk: string;
    readonly sources: readonly { readonly name: string; readonly value: string }[];
  }
): { readonly events: readonly OutputEvent[]; readonly diagnostics: readonly ContractEvidence[] } {
  const diagnostics = [...collectParseDiagnostics(fragments.sources)];
  const protocolChunk =
    adapter.id === 'pi'
      ? ((
          fragments.sources.find((source) => source.name === 'stdout') ??
          fragments.sources.find((source) => source.name === 'jsonl')
        )?.value ?? '')
      : fragments.chunk;
  try {
    return {
      events: parseProviderChunk(adapter.id, protocolChunk),
      diagnostics,
    };
  } catch (error) {
    return {
      events: [],
      diagnostics: [
        ...diagnostics,
        {
          kind: 'parser-error',
          message: unknownToMessage(error),
        },
      ],
    };
  }
}

export function runParseOutput(request: RequestData): ContractEnvelope {
  const adapter = adapterForProvider(request.provider);
  const fragments = parseFragments(request.raw);
  const parsed = parseOutputEvents(adapter, fragments);
  return successEnvelope({
    command: request.command ?? 'parse-output',
    adapter,
    redactions: envRedactions(request.env),
    result: parsed,
  });
}
