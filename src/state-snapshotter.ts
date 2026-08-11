import crypto = require('crypto');
import stateSnapshot = require('./state-snapshot');
import normalization = require('./state-snapshot-normalization');

interface SnapshotMessageBus {
  subscribeTopics(topics: string[], handler: (message: unknown) => void): () => void;
  findLast(query: { cluster_id: string; topic: string }): unknown;
  publish(message: {
    cluster_id: string;
    topic: 'STATE_SNAPSHOT';
    sender: 'state-snapshotter';
    receiver: 'broadcast';
    content: { text: string; data: object };
  }): unknown;
}

interface StateSnapshotterOptions {
  messageBus: SnapshotMessageBus;
  clusterId: string;
}

type SnapshotState = ReturnType<typeof stateSnapshot.initStateFromIssue>;
const SNAPSHOT_TOPICS = [
  'ISSUE_OPENED',
  'PLAN_READY',
  'WORKER_PROGRESS',
  'IMPLEMENTATION_READY',
  'VALIDATION_RESULT',
  'INVESTIGATION_COMPLETE',
];

function messageTimestamp(message: unknown): number {
  const timestamp = normalization.asRecord(message)?.timestamp;
  return timestamp ? Number(timestamp) : 0;
}

class StateSnapshotter {
  messageBus: SnapshotMessageBus;
  clusterId: string;
  state: object | null;
  lastHash: string | null;
  unsubscribe: (() => void) | null;

  constructor({ messageBus, clusterId }: StateSnapshotterOptions) {
    this.messageBus = messageBus;
    this.clusterId = clusterId;
    this.state = null;
    this.lastHash = null;
    this.unsubscribe = null;
  }

  start(): void {
    if (this.unsubscribe) {
      return;
    }

    this._bootstrapFromLedger();

    this.unsubscribe = this.messageBus.subscribeTopics(SNAPSHOT_TOPICS, (message: unknown) => {
      if (normalization.asRecord(message)?.cluster_id !== this.clusterId) return;
      this._handleMessage(message);
    });
  }

  stop(): void {
    if (!this.unsubscribe) return;
    this.unsubscribe();
    this.unsubscribe = null;
  }

  _bootstrapFromLedger(): void {
    const existing = this.messageBus.findLast({
      cluster_id: this.clusterId,
      topic: 'STATE_SNAPSHOT',
    });
    const existingData = normalization.asRecord(normalization.asRecord(existing)?.content)?.data;

    if (existingData && typeof existingData === 'object') {
      this.state = existingData;
      this.lastHash = this._hashState(this.state);
      return;
    }

    const messages = SNAPSHOT_TOPICS.map((topic) =>
      this.messageBus.findLast({ cluster_id: this.clusterId, topic })
    ).filter(Boolean);

    if (messages.length === 0) {
      return;
    }

    messages.sort((left, right) => messageTimestamp(left) - messageTimestamp(right));

    let state: object | null = null;
    for (const message of messages) {
      state = this._applyMessage(state, message);
    }

    if (state) {
      this.state = state;
      this._publishSnapshot(state);
    }
  }

  _handleMessage(message: unknown): void {
    const nextState = this._applyMessage(this.state, message);
    if (!nextState) return;

    this.state = nextState;
    this._publishSnapshot(nextState);
  }

  _applyMessage(state: object | null, message: unknown): SnapshotState | object | null {
    switch (normalization.asRecord(message)?.topic) {
      case 'ISSUE_OPENED':
        return state
          ? stateSnapshot.applyIssueOpened(state, message)
          : stateSnapshot.initStateFromIssue(message);
      case 'PLAN_READY':
        return stateSnapshot.applyPlanReady(state, message);
      case 'WORKER_PROGRESS':
        return stateSnapshot.applyWorkerProgress(state, message);
      case 'IMPLEMENTATION_READY':
        return stateSnapshot.applyImplementationReady(state, message);
      case 'VALIDATION_RESULT':
        return stateSnapshot.applyValidationResult(state, message);
      case 'INVESTIGATION_COMPLETE':
        return stateSnapshot.applyInvestigationComplete(state, message);
      default:
        return state;
    }
  }

  _publishSnapshot(state: object): void {
    const hash = this._hashState(state);
    if (this._hashEquals(hash, this.lastHash)) {
      return;
    }
    this.lastHash = hash;

    this.messageBus.publish({
      cluster_id: this.clusterId,
      topic: 'STATE_SNAPSHOT',
      sender: 'state-snapshotter',
      receiver: 'broadcast',
      content: {
        text: stateSnapshot.renderStateSummary(state),
        data: state,
      },
    });
  }

  _hashState(state: object): string {
    const serialized = JSON.stringify(state);
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  _hashEquals(left: string | null, right: string | null): boolean {
    if (!left || !right) return false;
    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }
}

export = StateSnapshotter;
