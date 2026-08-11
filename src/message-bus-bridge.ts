/**
 * Bridges parent and child message buses while preserving cluster isolation and
 * preventing forwarding loops.
 */

interface BridgeMetadata extends Record<string, unknown> {
  forwarded?: unknown;
}

interface BridgeMessage extends Record<string, unknown> {
  cluster_id: string;
  topic: string;
  metadata?: BridgeMetadata;
}

interface BridgeMessageBus {
  subscribe(handler: (message: BridgeMessage) => void): () => void;
  publish(message: BridgeMessage): unknown;
}

interface MessageBusBridgeConfig {
  parentClusterId: string;
  childClusterId: string;
  parentTopics?: unknown[];
}

function parentTopicName(entry: unknown): unknown {
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object' || entry === null) return undefined;
  return 'topic' in entry ? entry.topic : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

class MessageBusBridge {
  parentBus: BridgeMessageBus;
  childBus: BridgeMessageBus;
  config: MessageBusBridgeConfig;
  parentTopicNames: Set<string>;
  parentUnsubscribe: (() => void) | null;
  childUnsubscribe: (() => void) | null;
  active: boolean;

  constructor(
    parentBus: BridgeMessageBus,
    childBus: BridgeMessageBus,
    config: MessageBusBridgeConfig
  ) {
    this.parentBus = parentBus;
    this.childBus = childBus;
    this.config = config;
    this.parentTopicNames = new Set(
      (config.parentTopics || []).map(parentTopicName).filter(isNonEmptyString)
    );

    this.parentUnsubscribe = null;
    this.childUnsubscribe = null;
    this.active = false;

    this._setupBridge();
  }

  _setupBridge(): void {
    if (this.parentTopicNames.size > 0) {
      this.parentUnsubscribe = this.parentBus.subscribe((message: BridgeMessage) => {
        this._forwardParentToChild(message);
      });
    }

    this.childUnsubscribe = this.childBus.subscribe((message: BridgeMessage) => {
      this._forwardChildToParent(message);
    });

    this.active = true;
  }

  _forwardParentToChild(message: BridgeMessage): void {
    if (message.cluster_id !== this.config.parentClusterId) {
      return;
    }

    if (!this.parentTopicNames.has(message.topic)) {
      return;
    }

    if (message.metadata?.forwarded) {
      return;
    }

    this.childBus.publish({
      ...message,
      cluster_id: this.config.childClusterId,
      metadata: {
        ...message.metadata,
        forwarded: true,
        forwardedFrom: this.config.parentClusterId,
      },
    });
  }

  _forwardChildToParent(message: BridgeMessage): void {
    if (message.cluster_id !== this.config.childClusterId) {
      return;
    }

    const forwardTopics = ['CLUSTER_COMPLETE', 'CLUSTER_FAILED', 'AGENT_ERROR'];
    if (!forwardTopics.includes(message.topic)) {
      return;
    }

    if (message.metadata?.forwarded) {
      return;
    }

    this.parentBus.publish({
      ...message,
      cluster_id: this.config.parentClusterId,
      topic: `CHILD_${message.topic}`,
      metadata: {
        ...message.metadata,
        forwarded: true,
        forwardedFrom: this.config.childClusterId,
        childClusterId: this.config.childClusterId,
      },
    });
  }

  close(): void {
    if (this.parentUnsubscribe) {
      this.parentUnsubscribe();
      this.parentUnsubscribe = null;
    }

    if (this.childUnsubscribe) {
      this.childUnsubscribe();
      this.childUnsubscribe = null;
    }

    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }
}

export = MessageBusBridge;
