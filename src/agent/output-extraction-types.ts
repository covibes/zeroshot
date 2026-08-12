export type JsonRecord = Record<string, unknown>;

export interface ProvidersParserBoundary {
  parseProviderChunk(providerName: string, chunk: string): readonly unknown[];
}

export interface CliFailureDiagnostic {
  byteLength: number;
  sha256: string;
}

export interface CliErrorDetail {
  error: string;
  diagnostic: CliFailureDiagnostic;
}

export interface CliFailure extends CliErrorDetail {
  provider: string;
}

export interface CliError {
  error: string;
  provider: string;
}

export interface VertexModelFailure {
  model: string;
}

export interface PiAssistantMessage extends JsonRecord {
  role: 'assistant';
  content: unknown[];
  usage: JsonRecord;
  stopReason: string;
}

export interface PiProtocolState {
  latestAssistant: PiAssistantMessage | null;
  settled: boolean;
}

export interface StructuredOutputExtractionBoundary {
  extractCliError(output: string, providerName: string): CliError | null;
  extractJsonFromOutput(output: string, providerName: string): object | null;
}

export interface FailureOutputExtractionBoundary {
  extractCliFailure(output: string, providerName: string): CliFailure | null;
}
