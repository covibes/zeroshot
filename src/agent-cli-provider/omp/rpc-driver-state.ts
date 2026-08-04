import {
  DEFAULT_OMP_RPC_DECODER_LIMITS,
  OmpRpcFrameDecoder,
  type OmpRpcCommand,
} from './rpc-protocol';
import { createOmpRpcEventState } from './rpc-events';
import { getBoolean, getRecord, getString } from '../json';
import type { OmpSessionLaunch } from './rpc-session';
import type { CommandSpec, OutputEvent } from '../types';

export interface OmpRpcSpawnEvidence {
  readonly pid: number;
  readonly processGroupId: number | null;
  readonly terminationStrategy: 'process-group' | 'process-tree';
}

export interface OmpRpcSessionEvidence {
  readonly phase: 'ready' | 'terminal';
  readonly sessionId: string | null;
  readonly sessionFile: string | null;
  readonly selectedProvider: string;
  readonly selectedModel: string;
  readonly thinkingLevel: string;
}

export interface OmpRpcTaskRequest {
  readonly commandSpec: CommandSpec;
  readonly prompt: string;
  readonly expectedVersion: string;
  readonly session: OmpSessionLaunch;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly abortGraceMs: number;
  readonly exitGraceMs: number;
}

export interface OmpRpcTaskHooks {
  readonly onSpawn: (evidence: OmpRpcSpawnEvidence) => Promise<void>;
  readonly onEvent: (event: OutputEvent) => Promise<void>;
  readonly onSession: (evidence: OmpRpcSessionEvidence) => Promise<void>;
}

export interface OmpRpcTaskResult {
  readonly events: readonly OutputEvent[];
  readonly text: string;
  readonly session: OmpRpcSessionEvidence;
  readonly stopReason: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export const UNKNOWN_SESSION_EVIDENCE: Omit<OmpRpcSessionEvidence, 'phase'> = {
  sessionId: null,
  sessionFile: null,
  selectedProvider: '',
  selectedModel: '',
  thinkingLevel: '',
};

type UiResponder = (id: string) => OmpRpcCommand;

// extension_ui_request method table (docs/rpc.md "Extension UI Sub-Protocol"). Zeroshot has no
// interactive host surface, so every method resolves to a cancelled/no-op response instead of
// blocking the child indefinitely.
export const UI_RESPONDERS: Readonly<Record<string, UiResponder>> = {
  confirm: (id) => ({ type: 'extension_ui_response', id, confirmed: false, cancelled: true }),
  select: (id) => ({ type: 'extension_ui_response', id, cancelled: true }),
  input: (id) => ({ type: 'extension_ui_response', id, cancelled: true }),
  editor: (id) => ({ type: 'extension_ui_response', id, cancelled: true }),
  open_url: (id) => ({ type: 'extension_ui_response', id, cancelled: true }),
  notify: (id) => ({ type: 'extension_ui_response', id, cancelled: false }),
  setStatus: (id) => ({ type: 'extension_ui_response', id, cancelled: false }),
  setWidget: (id) => ({ type: 'extension_ui_response', id, cancelled: false }),
  setTitle: (id) => ({ type: 'extension_ui_response', id, cancelled: false }),
  set_editor_text: (id) => ({ type: 'extension_ui_response', id, cancelled: false }),
  cancel: (id) => ({ type: 'extension_ui_response', id, cancelled: false }),
};

export class OmpRpcTaskFailure extends Error {
  readonly stopReason: string;

  constructor(stopReason: string, message: string) {
    super(message);
    this.name = 'OmpRpcTaskFailure';
    this.stopReason = stopReason;
  }
}

export interface PendingCommand {
  readonly resolve: (frame: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

export interface DriverState {
  readonly decoder: OmpRpcFrameDecoder;
  readonly eventState: ReturnType<typeof createOmpRpcEventState>;
  readonly pending: Map<string, PendingCommand>;
  readonly lifetimeRequestIds: Set<string>;
  queuedFrames: number;
  readonly events: OutputEvent[];
  readonly textParts: string[];
  stderrTail: string;
  negotiatedV2: boolean;
  readyReceived: boolean;
  promptSent: boolean;
  terminal: boolean;
  settled: boolean;
  abortStopReason: string | null;
  pendingStopReason: string | null;
  terminationStarted: boolean;
  sessionEvidence: Omit<OmpRpcSessionEvidence, 'phase'>;
  processExit: { exitCode: number | null; signal: string | null } | null;
  chain: Promise<void>;
}

export function createDriverState(): DriverState {
  return {
    decoder: new OmpRpcFrameDecoder(DEFAULT_OMP_RPC_DECODER_LIMITS),
    eventState: createOmpRpcEventState(),
    pending: new Map(),
    lifetimeRequestIds: new Set(),
    queuedFrames: 0,
    events: [],
    textParts: [],
    stderrTail: '',
    negotiatedV2: false,
    readyReceived: false,
    promptSent: false,
    terminal: false,
    settled: false,
    abortStopReason: null,
    pendingStopReason: null,
    terminationStarted: false,
    sessionEvidence: UNKNOWN_SESSION_EVIDENCE,
    processExit: null,
    chain: Promise.resolve(),
  };
}

export function sessionFieldsFromRecord(
  record: Record<string, unknown>
): Partial<Pick<OmpRpcSessionEvidence, 'sessionId' | 'sessionFile'>> {
  const sessionId = getString(record, 'sessionId');
  const sessionFile = getString(record, 'sessionFile');
  return {
    ...(sessionId !== null ? { sessionId } : {}),
    ...(sessionFile !== null ? { sessionFile } : {}),
  };
}

export function sessionEvidenceFromState(
  stateResponse: Record<string, unknown> | null
): Omit<OmpRpcSessionEvidence, 'phase'> {
  if (stateResponse === null || getBoolean(stateResponse, 'success') !== true)
    return UNKNOWN_SESSION_EVIDENCE;
  const data = getRecord(stateResponse, 'data');
  const model = data ? getRecord(data, 'model') : null;
  return {
    ...UNKNOWN_SESSION_EVIDENCE,
    ...(data ? sessionFieldsFromRecord(data) : {}),
    selectedProvider: (model ? getString(model, 'provider') : null) ?? '',
    selectedModel: (model ? getString(model, 'id') : null) ?? '',
    thinkingLevel: (data ? getString(data, 'thinkingLevel') : null) ?? '',
  };
}
