const RAW_LOG_ONLY_REPLAY_POLICY = 'raw_log_only';
const CONTEXT_REPLAY_POLICY = 'context';

type ReplayMetadata = Record<string, unknown> & {
  readonly contextSafe?: unknown;
  readonly replayPolicy?: unknown;
};

interface ReplayMessage {
  readonly topic?: unknown;
  readonly metadata?: ReplayMetadata | null;
  readonly content?: {
    readonly data?: {
      readonly contextSafe?: unknown;
      readonly replayPolicy?: unknown;
    } | null;
  } | null;
}

function buildRawLogOnlyMetadata(extra: Record<string, unknown> = {}): {
  contextSafe: false;
  replayPolicy: typeof RAW_LOG_ONLY_REPLAY_POLICY;
  [key: string]: unknown;
} {
  return {
    ...extra,
    contextSafe: false,
    replayPolicy: RAW_LOG_ONLY_REPLAY_POLICY,
  };
}

function getReplayPolicy(message: ReplayMessage | null | undefined): unknown {
  return message?.metadata?.replayPolicy ?? message?.content?.data?.replayPolicy;
}

function getContextSafe(message: ReplayMessage | null | undefined): boolean | null {
  if (typeof message?.metadata?.contextSafe === 'boolean') {
    return message.metadata.contextSafe;
  }

  if (typeof message?.content?.data?.contextSafe === 'boolean') {
    return message.content.data.contextSafe;
  }

  return null;
}

function isReplayableMessage(message: ReplayMessage | null | undefined): boolean {
  const contextSafe = getContextSafe(message);
  if (contextSafe !== null) {
    return contextSafe;
  }

  const replayPolicy = getReplayPolicy(message);
  if (replayPolicy === RAW_LOG_ONLY_REPLAY_POLICY) {
    return false;
  }

  if (replayPolicy === CONTEXT_REPLAY_POLICY) {
    return true;
  }

  return message?.topic !== 'AGENT_OUTPUT';
}

export = {
  RAW_LOG_ONLY_REPLAY_POLICY,
  CONTEXT_REPLAY_POLICY,
  buildRawLogOnlyMetadata,
  isReplayableMessage,
};
