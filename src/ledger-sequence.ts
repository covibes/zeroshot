const MAX_SQLITE_ROWID = 9223372036854775807n;
const CANONICAL_SEQUENCE = /^(0|[1-9][0-9]*)$/;

function canonicalMessageSequence(value: unknown, name = 'message sequence'): string {
  let sequence: string;
  if (typeof value === 'string' && CANONICAL_SEQUENCE.test(value)) {
    sequence = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    // Accept legacy JSON state while normalizing every new boundary to a
    // JSON-safe decimal string.
    sequence = String(value);
  } else {
    throw new TypeError(`${name} must be a canonical non-negative decimal string`);
  }

  if (BigInt(sequence) > MAX_SQLITE_ROWID) {
    throw new RangeError(`${name} exceeds the SQLite rowid range`);
  }
  return sequence;
}

function messageSequenceFromSql(value: unknown, name = 'message sequence'): string {
  if (typeof value === 'bigint') {
    if (value < 0n || value > MAX_SQLITE_ROWID) {
      throw new RangeError(`${name} is outside the SQLite rowid range`);
    }
    return value.toString();
  }
  return canonicalMessageSequence(value, name);
}

function messageSequenceToSql(value: unknown, name = 'message sequence'): bigint {
  return BigInt(canonicalMessageSequence(value, name));
}

function compareMessageSequences(left: unknown, right: unknown): -1 | 0 | 1 {
  const leftValue = messageSequenceToSql(left, 'left message sequence');
  const rightValue = messageSequenceToSql(right, 'right message sequence');
  if (leftValue < rightValue) {
    return -1;
  }
  if (leftValue > rightValue) {
    return 1;
  }
  return 0;
}

function tryCanonicalMessageSequence(value: unknown): string | null {
  try {
    return canonicalMessageSequence(value);
  } catch {
    return null;
  }
}

export = {
  MAX_SQLITE_ROWID,
  canonicalMessageSequence,
  compareMessageSequences,
  messageSequenceFromSql,
  messageSequenceToSql,
  tryCanonicalMessageSequence,
};
