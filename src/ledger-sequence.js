const MAX_SQLITE_ROWID = 9223372036854775807n;
const CANONICAL_SEQUENCE = /^(0|[1-9][0-9]*)$/;

function canonicalMessageSequence(value, name = 'message sequence') {
  let sequence;
  if (typeof value === 'string' && CANONICAL_SEQUENCE.test(value)) {
    sequence = value;
  } else if (Number.isSafeInteger(value) && value >= 0) {
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

function messageSequenceFromSql(value, name = 'message sequence') {
  if (typeof value === 'bigint') {
    if (value < 0n || value > MAX_SQLITE_ROWID) {
      throw new RangeError(`${name} is outside the SQLite rowid range`);
    }
    return value.toString();
  }
  return canonicalMessageSequence(value, name);
}

function messageSequenceToSql(value, name = 'message sequence') {
  return BigInt(canonicalMessageSequence(value, name));
}

function compareMessageSequences(left, right) {
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

function tryCanonicalMessageSequence(value) {
  try {
    return canonicalMessageSequence(value);
  } catch {
    return null;
  }
}

module.exports = {
  MAX_SQLITE_ROWID,
  canonicalMessageSequence,
  compareMessageSequences,
  messageSequenceFromSql,
  messageSequenceToSql,
  tryCanonicalMessageSequence,
};
