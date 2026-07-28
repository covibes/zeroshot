pub const APPLICATION_ID: i32 = 0x5a4c_4544;
pub const SCHEMA_VERSION: i64 = 2;

pub const CREATE_SCHEMA: &str = "
CREATE TABLE metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    resource_id TEXT NOT NULL
) STRICT;
CREATE TABLE fence (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    owner_id TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK (epoch > 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0)
) STRICT;
CREATE TABLE records (
    sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
    family INTEGER NOT NULL,
    kind INTEGER NOT NULL,
    version INTEGER NOT NULL,
    payload BLOB NOT NULL,
    previous_hash BLOB NOT NULL CHECK (length(previous_hash) = 32),
    record_hash BLOB NOT NULL CHECK (length(record_hash) = 32)
) STRICT;
CREATE TABLE receipts (
    idempotency_key TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    fingerprint BLOB NOT NULL CHECK (length(fingerprint) = 32),
    response BLOB NOT NULL,
    committed_position INTEGER NOT NULL CHECK (committed_position > 0)
) STRICT;
CREATE TABLE removal_tombstone (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    resource_id TEXT NOT NULL,
    removed_position INTEGER NOT NULL CHECK (removed_position >= 0)
) STRICT;
";
