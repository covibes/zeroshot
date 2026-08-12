export interface JsonSchema {
  readonly type?: string;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, JsonSchema | null | undefined>>;
}

export interface LegacyOutputFormat {
  readonly rules?: readonly string[];
  readonly example?: unknown;
}

export interface PromptObject {
  readonly system?: string | null;
  readonly outputFormat?: LegacyOutputFormat | null;
}

export interface ContextSource {
  topic: string;
  sender?: unknown;
  since?: unknown;
  amount?: number;
  limit?: number;
  strategy?: string;
  compactAmount?: number;
  compactStrategy?: string;
  priority?: string;
}

export interface ContextStrategy {
  maxTokens?: number;
  sources?: ContextSource[];
  readonly [key: string]: unknown;
}

export interface AgentContextConfig {
  readonly prompt?: string | PromptObject | null;
  readonly promptConfig?: {
    readonly type?: string | null;
  } | null;
  readonly cwd?: string | null;
  readonly jsonSchema?: JsonSchema | null;
  readonly outputFormat?: string | null;
  readonly role?: string;
  readonly requiredQualityGates?: unknown;
  readonly commandProofs?: unknown;
  readonly contextStrategy?: ContextStrategy | null;
}

export interface WorktreeContext {
  readonly enabled?: boolean;
  readonly path?: string | null;
}

export interface IsolationContext {
  readonly enabled?: boolean;
}

export interface ValidationCriterion {
  readonly status?: string;
  readonly id?: string;
  readonly reason?: string;
}

export interface ContextMessageData {
  readonly criteriaResults?: readonly ValidationCriterion[] | null;
  readonly contextSafe?: unknown;
  readonly replayPolicy?: unknown;
  readonly [key: string]: unknown;
}

export interface ContextMessage {
  readonly id?: unknown;
  readonly topic?: unknown;
  readonly timestamp: string | number;
  readonly sender: string;
  readonly metadata?: ContextMessageData | null;
  readonly content?: {
    readonly text?: string | null;
    readonly data?: ContextMessageData | null;
  } | null;
}

export interface ContextQuery {
  cluster_id: string;
  topic: string;
  sender?: unknown;
  since?: unknown;
  afterId?: unknown;
  throughId?: unknown;
  limit?: number;
}

export interface ContextMessageBus {
  query(criteria: ContextQuery): ContextMessage[];
  publish(message: unknown): unknown;
}

export interface ContextCluster {
  id: string;
  createdAt: number;
}

export interface TriggeringMessage {
  id?: unknown;
  topic: string;
  sender: string;
  content?: {
    text?: string | null;
  } | null;
}

export interface BuildContextParams {
  id: string;
  role: string;
  iteration: number;
  config: AgentContextConfig;
  messageBus: ContextMessageBus;
  cluster: ContextCluster;
  triggeringMessage: TriggeringMessage;
  lastTaskEndTime?: number | null | undefined;
  lastAgentStartTime?: number | null | undefined;
  selectedPrompt?: string | null | undefined;
  queuedGuidance?: string | null | undefined;
  worktree?: WorktreeContext | null | undefined;
  isolation?: IsolationContext | null | undefined;
  mode?: string | undefined;
  continuationSequence?: unknown;
  contextThroughId?: unknown;
  previousPromptIdentity?: unknown;
  currentPromptIdentity?: unknown;
}
