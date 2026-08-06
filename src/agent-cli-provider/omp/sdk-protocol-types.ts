import { OMP_SDK_TOOL_IDS } from './sdk-settings';
import type {
  OmpModelsConfig,
  OmpSdkAuth,
  OmpSdkToolId as SettingsOmpSdkToolId,
} from './sdk-settings';
import type { OmpSdkTerminalEvidence, ReasoningEffort, ResultEvent } from '../types';

export const OMP_SDK_PROTOCOL_VERSION = 1 as const;
export const OMP_SDK_BACKEND_VERSION = '17.2.1' as const;
export const OMP_SDK_BUN_VERSION = '1.3.14' as const;
export const OMP_SDK_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const OMP_SDK_MAX_FRAME_BYTES = 1024 * 1024;
export const OMP_SDK_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const OMP_SDK_MAX_CREDENTIAL_BYTES = 64 * 1024;

export const OMP_SDK_EXECUTION_CONTEXTS = ['host', 'detached', 'docker', 'benchmark'] as const;
export { OMP_SDK_TOOL_IDS };
export type OmpSdkToolId = SettingsOmpSdkToolId;
export type OmpSdkRequestAuth = OmpSdkAuth;
export type OmpSdkModelsConfig = OmpModelsConfig;
export type OmpSdkOutputMode = 'json' | 'text';
export type OmpSdkExecutionContext = (typeof OMP_SDK_EXECUTION_CONTEXTS)[number];

interface OmpSdkRequestBase {
  readonly protocolVersion: 1;
  readonly runId: string;
  readonly cwd: string;
  readonly executionContext: OmpSdkExecutionContext;
  readonly prompt: string;
  readonly modelSelector: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly modelsConfig: OmpSdkModelsConfig;
  readonly auth: OmpSdkRequestAuth;
  readonly tools: readonly OmpSdkToolId[];
  readonly context: string;
}

export interface OmpSdkJsonSidecarRequest extends OmpSdkRequestBase {
  readonly outputMode: 'json';
  readonly outputSchema: boolean | Readonly<Record<string, unknown>>;
}
export interface OmpSdkTextSidecarRequest extends OmpSdkRequestBase {
  readonly outputMode: 'text';
  readonly outputSchema?: never;
}
export type OmpSdkSidecarRequest = OmpSdkJsonSidecarRequest | OmpSdkTextSidecarRequest;

export const OMP_SDK_TEXT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({ result: Object.freeze({ type: 'string' }) }),
  required: Object.freeze(['result']),
  additionalProperties: false,
}) as Readonly<Record<string, unknown>>;

export const OMP_SDK_PROGRESS_STAGES = [
  'starting',
  'resolving-model',
  'running',
  'tearing-down',
] as const;
export type OmpSdkProgressStage = (typeof OMP_SDK_PROGRESS_STAGES)[number];

export interface OmpSdkProtocolProgressFrame {
  readonly protocolVersion: 1;
  readonly type: 'progress';
  readonly runId: string;
  readonly sequence: number;
  readonly stage: OmpSdkProgressStage;
}
export interface OmpSdkProtocolResultFrame extends OmpSdkTerminalEvidence {
  readonly protocolVersion: 1;
  readonly type: 'result';
  readonly runId: string;
  readonly value: unknown;
}

export const OMP_SDK_ERROR_CODES = [
  'invalid-request',
  'model-resolution',
  'model-fallback',
  'provider-auth',
  'provider-rate-limit',
  'provider-timeout',
  'provider-error',
  'schema-violation',
  'cancelled',
  'sdk-error',
  'cleanup-error',
  'internal-error',
] as const;
export type OmpSdkErrorCode = (typeof OMP_SDK_ERROR_CODES)[number];
export type OmpSdkErrorCategory =
  | 'request'
  | 'model'
  | 'auth'
  | 'rate-limit'
  | 'timeout'
  | 'provider'
  | 'schema'
  | 'cancelled'
  | 'sdk'
  | 'cleanup'
  | 'internal';
export interface OmpSdkSafeError {
  readonly code: OmpSdkErrorCode;
  readonly category: OmpSdkErrorCategory;
  readonly retryable: boolean;
  readonly redacted: true;
}
export interface OmpSdkProtocolErrorFrame {
  readonly protocolVersion: 1;
  readonly type: 'error';
  readonly runId: string;
  readonly backend: OmpSdkTerminalEvidence['backend'];
  readonly runtime: OmpSdkTerminalEvidence['runtime'];
  readonly error: OmpSdkSafeError;
}
export type OmpSdkProtocolFrame =
  | OmpSdkProtocolProgressFrame
  | OmpSdkProtocolResultFrame
  | OmpSdkProtocolErrorFrame;
export type OmpSdkProtocolTerminalFrame = OmpSdkProtocolResultFrame | OmpSdkProtocolErrorFrame;
export type OmpSdkCollectedTerminal =
  | {
      readonly type: 'result';
      readonly frame: OmpSdkProtocolResultFrame;
      readonly event: ResultEvent;
    }
  | { readonly type: 'error'; readonly frame: OmpSdkProtocolErrorFrame };

export interface OmpSdkProtocolCollectorOptions {
  readonly request: OmpSdkSidecarRequest;
  readonly maxFrameBytes?: number;
  readonly maxStdoutBytes?: number;
}
export interface OmpSdkProtocolCollector {
  readonly progress: readonly OmpSdkProtocolProgressFrame[];
  write(chunk: string | Uint8Array): readonly OmpSdkProtocolFrame[];
  finish(exitCode: number): OmpSdkCollectedTerminal;
}

export const CATEGORY: Readonly<Record<OmpSdkErrorCode, OmpSdkErrorCategory>> = {
  'invalid-request': 'request',
  'model-resolution': 'model',
  'model-fallback': 'model',
  'provider-auth': 'auth',
  'provider-rate-limit': 'rate-limit',
  'provider-timeout': 'timeout',
  'provider-error': 'provider',
  'schema-violation': 'schema',
  cancelled: 'cancelled',
  'sdk-error': 'sdk',
  'cleanup-error': 'cleanup',
  'internal-error': 'internal',
};
