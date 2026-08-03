/**
 * Task Store - SQLite-backed storage for tasks and schedules
 *
 * Uses WAL mode for concurrent access - no file locks needed.
 * Multiple processes can read/write simultaneously without contention.
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { TASKS_DIR, LOGS_DIR } from './config.js';
import { generateName } from './name-generator.js';
import {
  inspectStoredOmpSessionOwnership,
  parseOmpSessionOwnership,
  serializeOmpSessionOwnership,
} from './omp-session-ownership-schema.js';

const DB_FILE = join(TASKS_DIR, 'store.db');
export const TASK_STORE_SCHEMA_VERSION = 6;

/** @type {Database.Database | null} */
let db = null;

/**
 * Get or create the database connection
 * @returns {Database.Database}
 */
function getDb() {
  if (db) return db;

  ensureDirs();

  db = new Database(DB_FILE, { timeout: 5000 });

  // WAL mode for concurrent access - this is the key fix
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT,
      full_prompt TEXT,
      cwd TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      pid INTEGER,
      session_id TEXT,
      session_id_conflict INTEGER NOT NULL DEFAULT 0,
      requested_resume_session_id TEXT,
      resume_identity_verified INTEGER NOT NULL DEFAULT 0,
      log_file TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      exit_code INTEGER,
      error TEXT,
      provider TEXT,
      model TEXT,
      schedule_id TEXT,
      socket_path TEXT,
      attachable INTEGER DEFAULT 0,
      process_group_id INTEGER,
      termination_strategy TEXT,
      command_cleanup TEXT,
      cancel_requested INTEGER DEFAULT 0,
      spawn_ownership_token TEXT,
      omp_session_ownership TEXT,
      input_digest TEXT,
      input_size_bytes INTEGER,
      invoke TEXT,
      execution_identity TEXT,
      semantic_identity TEXT,
      containment_requirement TEXT,
      parsed_result TEXT,
      sdk_evidence TEXT,
      cleanup_attestation TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      cron TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cwd TEXT,
      model TEXT,
      model_level TEXT,
      reasoning_effort TEXT,
      provider TEXT,
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      next_run TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
  `);

  migrateTaskStore(db);

  return db;
}

function ensureTaskColumn(database, name, definition) {
  const columns = database.pragma('table_info(tasks)');
  if (!columns.some((column) => column.name === name)) {
    database.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
  }
}

function parseCommandCleanup(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function serializeCommandCleanup(value) {
  return value ? JSON.stringify(value) : null;
}

/**
 * Internal accessor for modules that need direct prepared-statement access (SQL compare-and-swap
 * transitions) beyond what the generic load/save/update helpers below offer. See
 * task-lib/omp-session-ownership.js.
 */
export function getTaskStoreDatabase() {
  return getDb();
}

const OMP_SDK_BACKEND = 'omp-sdk';
const OMP_SDK_PARSER = 'omp-sdk-ndjson';

function parseStoredJson(value, field) {
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Task store contains invalid ${field}`);
  }
}

function serializeStoredJson(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function isOmpSdkTask(task) {
  const hasSdkBackend = task?.executionIdentity?.backend === OMP_SDK_BACKEND;
  const hasSdkParser = task?.invoke?.parser === OMP_SDK_PARSER;
  if (hasSdkBackend !== hasSdkParser) {
    throw new Error(
      `OMP SDK task identity requires both executionIdentity.backend="${OMP_SDK_BACKEND}" and invoke.parser="${OMP_SDK_PARSER}"`
    );
  }
  return hasSdkBackend;
}

function sdkPersistenceValues(task) {
  if (!isOmpSdkTask(task)) {
    return {
      prompt: task.prompt || null,
      fullPrompt: task.fullPrompt || null,
      inputDigest: null,
      inputSizeBytes: null,
      invoke: null,
      executionIdentity: null,
      semanticIdentity: null,
      containmentRequirement: null,
      parsedResult: null,
      sdkEvidence: null,
      cleanupAttestation: null,
    };
  }

  return {
    prompt: null,
    fullPrompt: null,
    inputDigest: serializeStoredJson(task.inputDigest),
    inputSizeBytes: task.inputSizeBytes ?? null,
    invoke: serializeStoredJson(task.invoke),
    executionIdentity: serializeStoredJson(task.executionIdentity),
    semanticIdentity: serializeStoredJson(task.semanticIdentity),
    containmentRequirement: serializeStoredJson(task.containmentRequirement),
    parsedResult: serializeStoredJson(task.parsedResult),
    sdkEvidence: serializeStoredJson(task.sdkEvidence),
    cleanupAttestation: serializeStoredJson(task.cleanupAttestation),
  };
}

export function migrateTaskStore(database) {
  ensureTaskColumn(database, 'process_group_id', 'INTEGER');
  ensureTaskColumn(database, 'termination_strategy', 'TEXT');
  ensureTaskColumn(database, 'command_cleanup', 'TEXT');
  ensureTaskColumn(database, 'cancel_requested', 'INTEGER DEFAULT 0');
  ensureTaskColumn(database, 'spawn_ownership_token', 'TEXT');
  ensureTaskColumn(database, 'requested_resume_session_id', 'TEXT');
  ensureTaskColumn(database, 'session_id_conflict', 'INTEGER NOT NULL DEFAULT 0');
  ensureTaskColumn(database, 'resume_identity_verified', 'INTEGER NOT NULL DEFAULT 0');
  // No backfill: every pre-v5 row has no OMP session concept, so NULL is exact truth, never a
  // fabricated value. A non-OMP task's resume path is untouched by this column.
  ensureTaskColumn(database, 'omp_session_ownership', 'TEXT');
  ensureTaskColumn(database, 'input_digest', 'TEXT');
  ensureTaskColumn(database, 'input_size_bytes', 'INTEGER');
  ensureTaskColumn(database, 'invoke', 'TEXT');
  ensureTaskColumn(database, 'execution_identity', 'TEXT');
  ensureTaskColumn(database, 'semantic_identity', 'TEXT');
  ensureTaskColumn(database, 'containment_requirement', 'TEXT');
  ensureTaskColumn(database, 'parsed_result', 'TEXT');
  ensureTaskColumn(database, 'sdk_evidence', 'TEXT');
  ensureTaskColumn(database, 'cleanup_attestation', 'TEXT');
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_spawn_ownership_token
      ON tasks(spawn_ownership_token)
      WHERE spawn_ownership_token IS NOT NULL
  `);

  const version = database.pragma('user_version', { simple: true });
  if (version >= TASK_STORE_SCHEMA_VERSION) return;

  database.transaction(() => {
    if (version < 2) {
      database
        .prepare(
          `UPDATE tasks
           SET requested_resume_session_id = COALESCE(requested_resume_session_id, session_id),
               session_id = NULL`
        )
        .run();
    }
    if (version < 3) {
      database.prepare('UPDATE tasks SET session_id_conflict = 0').run();
    }
    if (version < 4) {
      database.prepare('UPDATE tasks SET resume_identity_verified = 0').run();
    }
    if (version < 5) {
      // omp_session_ownership already defaults to NULL via ensureTaskColumn above; no backfill.
    }
    if (version < 6) {
      // SDK evidence columns already default to NULL via ensureTaskColumn above; legacy rows stay
      // legacy rows rather than receiving a fabricated SDK identity or terminal result.
    }
    database.pragma(`user_version = ${TASK_STORE_SCHEMA_VERSION}`);
  })();
}

function nullable(value) {
  return value || null;
}

export function ensureDirs() {
  if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
}

// ============================================================================
// Tasks
// ============================================================================

/**
 * Convert DB row to task object (camelCase)
 */
function rowToTask(row) {
  if (!row) return null;
  const task = {
    id: row.id,
    prompt: row.prompt,
    fullPrompt: row.full_prompt,
    cwd: row.cwd,
    status: row.status,
    pid: row.pid,
    sessionId: row.session_id,
    sessionIdConflict: Boolean(row.session_id_conflict),
    requestedResumeSessionId: row.requested_resume_session_id,
    resumeIdentityVerified: Boolean(row.resume_identity_verified),
    logFile: row.log_file,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    exitCode: row.exit_code,
    error: row.error,
    provider: row.provider,
    model: row.model,
    scheduleId: row.schedule_id,
    socketPath: row.socket_path,
    attachable: Boolean(row.attachable),
    processGroupId: row.process_group_id,
    terminationStrategy: row.termination_strategy,
    commandCleanup: parseCommandCleanup(row.command_cleanup),
    cancelRequested: Boolean(row.cancel_requested),
    spawnOwnershipToken: row.spawn_ownership_token,
    ompSessionOwnership: parseOmpSessionOwnership(row.omp_session_ownership),
    // Raw-presence seam (see inspectStoredOmpSessionOwnership). `ompSessionOwnership: null` alone
    // cannot distinguish "this task never had an OMP session" from "this task's owner record is
    // unreadable", and those demand opposite handling: the first is nothing to clean, the second
    // means a partition may exist that only this row still points at. The malformed bytes
    // themselves are deliberately not exposed — nothing may act on them.
    ompSessionOwnershipPresent: inspectStoredOmpSessionOwnership(row.omp_session_ownership).present,
  };
  const invoke = parseStoredJson(row.invoke, 'invoke');
  const executionIdentity = parseStoredJson(row.execution_identity, 'execution_identity');
  if (!isOmpSdkTask({ invoke, executionIdentity })) return task;

  task.invoke = invoke;
  task.executionIdentity = executionIdentity;
  if (row.input_digest !== null) {
    task.inputDigest = parseStoredJson(row.input_digest, 'input_digest');
  }
  if (row.input_size_bytes !== null) task.inputSizeBytes = row.input_size_bytes;
  if (row.semantic_identity !== null) {
    task.semanticIdentity = parseStoredJson(row.semantic_identity, 'semantic_identity');
  }
  if (row.containment_requirement !== null) {
    task.containmentRequirement = parseStoredJson(
      row.containment_requirement,
      'containment_requirement'
    );
  }
  if (row.parsed_result !== null) {
    task.parsedResult = parseStoredJson(row.parsed_result, 'parsed_result');
  }
  if (row.sdk_evidence !== null) {
    task.sdkEvidence = parseStoredJson(row.sdk_evidence, 'sdk_evidence');
  }
  if (row.cleanup_attestation !== null) {
    task.cleanupAttestation = parseStoredJson(row.cleanup_attestation, 'cleanup_attestation');
  }
  return task;
}

/** True when a task row carries an `omp_session_ownership` value that exists but cannot be read as
 * the closed schema. Such a row is retained by every cleanup surface with a warning: deleting it
 * would orphan whatever partition the unreadable record described. */
export function hasUnreadableOmpSessionOwnership(task) {
  return Boolean(task?.ompSessionOwnershipPresent) && !task?.ompSessionOwnership;
}

/**
 * Load all tasks as object keyed by id
 * @returns {Object.<string, Object>}
 */
export function loadTasks() {
  const rows = getDb().prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
  const tasks = {};
  for (const row of rows) {
    const task = rowToTask(row);
    tasks[task.id] = task;
  }
  return tasks;
}

/**

 * Get a single task by id
 * @param {string} id
 * @returns {Object|null}
 */
export function getTask(id) {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return rowToTask(row);
}

export function getTaskBySpawnOwnershipToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const row = getDb().prepare('SELECT * FROM tasks WHERE spawn_ownership_token = ?').get(token);
  return rowToTask(row);
}

export function requestTaskCancellation(id) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE tasks
       SET cancel_requested = 1, updated_at = ?, error = ?
       WHERE id = ? AND status = 'running'`
    )
    .run(now, 'Cancellation requested before provider startup completed', id);
  return getTask(id);
}

/**
 * Update a task
 * @param {string} id
 * @param {Object} updates
 * @returns {Object|null}
 */
export function updateTask(id, updates) {
  const existing = getTask(id);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  getDb()
    .prepare(
      `
    UPDATE tasks SET
      prompt = @prompt,
      full_prompt = @fullPrompt,
      cwd = @cwd,
      status = @status,
      pid = @pid,
      session_id = @sessionId,
      session_id_conflict = @sessionIdConflict,
      requested_resume_session_id = @requestedResumeSessionId,
      resume_identity_verified = @resumeIdentityVerified,
      log_file = @logFile,
      updated_at = @updatedAt,
      exit_code = @exitCode,
      error = @error,
      provider = @provider,
      model = @model,
      schedule_id = @scheduleId,
      socket_path = @socketPath,
      attachable = @attachable,
      process_group_id = @processGroupId,
      termination_strategy = @terminationStrategy,
      command_cleanup = @commandCleanup,
      input_digest = @inputDigest,
      input_size_bytes = @inputSizeBytes,
      invoke = @invoke,
      execution_identity = @executionIdentity,
      semantic_identity = @semanticIdentity,
      containment_requirement = @containmentRequirement,
      parsed_result = @parsedResult,
      sdk_evidence = @sdkEvidence,
      cleanup_attestation = @cleanupAttestation,
      cancel_requested =
        CASE WHEN @hasCancelRequested = 1 THEN @cancelRequested ELSE cancel_requested END,
      -- Only ever written when the caller explicitly supplies it. This is a read-modify-write
      -- update, so unconditionally rewriting the ownership column would let an unrelated
      -- updateTask (the watcher persisting spawn evidence, say) clobber an owner-fenced
      -- compare-and-swap another process performed in between — see
      -- task-lib/omp-session-ownership.js, whose transitions bypass this statement for exactly
      -- that reason.
      omp_session_ownership =
        CASE WHEN @hasOmpSessionOwnership = 1 THEN @ompSessionOwnership ELSE omp_session_ownership END
    WHERE id = @id
  `
    )
    .run({
      id: updated.id,
      ...sdkPersistenceValues(updated),
      cwd: updated.cwd || null,
      status: updated.status || 'pending',
      pid: updated.pid || null,
      sessionId: updated.sessionId || null,
      sessionIdConflict: updated.sessionIdConflict ? 1 : 0,
      requestedResumeSessionId: nullable(updated.requestedResumeSessionId),
      resumeIdentityVerified: updated.resumeIdentityVerified ? 1 : 0,
      logFile: updated.logFile || null,
      updatedAt: updated.updatedAt,
      exitCode: updated.exitCode ?? null,
      error: updated.error || null,
      provider: updated.provider || null,
      model: updated.model || null,
      scheduleId: updated.scheduleId || null,
      socketPath: updated.socketPath || null,
      attachable: updated.attachable ? 1 : 0,
      processGroupId: updated.processGroupId || null,
      terminationStrategy: updated.terminationStrategy || null,
      commandCleanup: serializeCommandCleanup(updated.commandCleanup),
      hasCancelRequested: Object.prototype.hasOwnProperty.call(updates, 'cancelRequested') ? 1 : 0,
      cancelRequested: updated.cancelRequested ? 1 : 0,
      hasOmpSessionOwnership: Object.prototype.hasOwnProperty.call(updates, 'ompSessionOwnership')
        ? 1
        : 0,
      ompSessionOwnership: serializeOmpSessionOwnership(updated.ompSessionOwnership || null),
    });

  return isOmpSdkTask(updated) ? getTask(id) : updated;
}

/**
 * Add a new task
 * @param {Object} task
 * @returns {Object}
 */
export function addTask(task) {
  const now = new Date().toISOString();
  const fullTask = {
    ...task,
    createdAt: task.createdAt || now,
    updatedAt: task.updatedAt || now,
  };

  getDb()
    .prepare(
      `
    INSERT INTO tasks (
      id, prompt, full_prompt, cwd, status, pid, session_id, session_id_conflict, requested_resume_session_id, resume_identity_verified, log_file,
      created_at, updated_at, exit_code, error, provider, model,
      schedule_id, socket_path, attachable, process_group_id, termination_strategy,
      command_cleanup, cancel_requested, spawn_ownership_token, omp_session_ownership,
      input_digest, input_size_bytes, invoke, execution_identity, semantic_identity,
      containment_requirement, parsed_result, sdk_evidence, cleanup_attestation
    ) VALUES (
      @id, @prompt, @fullPrompt, @cwd, @status, @pid, @sessionId, @sessionIdConflict, @requestedResumeSessionId, @resumeIdentityVerified, @logFile,
      @createdAt, @updatedAt, @exitCode, @error, @provider, @model,
      @scheduleId, @socketPath, @attachable, @processGroupId, @terminationStrategy,
      @commandCleanup, @cancelRequested, @spawnOwnershipToken, @ompSessionOwnership,
      @inputDigest, @inputSizeBytes, @invoke, @executionIdentity, @semanticIdentity,
      @containmentRequirement, @parsedResult, @sdkEvidence, @cleanupAttestation
    )
  `
    )
    .run({
      id: fullTask.id,
      ...sdkPersistenceValues(fullTask),
      cwd: fullTask.cwd || null,
      status: fullTask.status || 'pending',
      pid: fullTask.pid || null,
      sessionId: fullTask.sessionId || null,
      sessionIdConflict: fullTask.sessionIdConflict ? 1 : 0,
      requestedResumeSessionId: nullable(fullTask.requestedResumeSessionId),
      resumeIdentityVerified: fullTask.resumeIdentityVerified ? 1 : 0,
      logFile: fullTask.logFile || null,
      createdAt: fullTask.createdAt,
      updatedAt: fullTask.updatedAt,
      exitCode: fullTask.exitCode ?? null,
      error: fullTask.error || null,
      provider: fullTask.provider || null,
      model: fullTask.model || null,
      scheduleId: fullTask.scheduleId || null,
      socketPath: fullTask.socketPath || null,
      attachable: fullTask.attachable ? 1 : 0,
      processGroupId: fullTask.processGroupId || null,
      terminationStrategy: fullTask.terminationStrategy || null,
      commandCleanup: serializeCommandCleanup(fullTask.commandCleanup),
      cancelRequested: fullTask.cancelRequested ? 1 : 0,
      spawnOwnershipToken: fullTask.spawnOwnershipToken || null,
      ompSessionOwnership: serializeOmpSessionOwnership(fullTask.ompSessionOwnership || null),
    });

  return isOmpSdkTask(fullTask) ? getTask(fullTask.id) : fullTask;
}

/**
 * Remove a task
 * @param {string} id
 */
export function removeTask(id) {
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

/**
 * Remove a task row only while it still matches the snapshot the caller validated.
 *
 * `clean`/`purge` decide what to remove from one `loadTasks()` snapshot and then do real work
 * (partition staging, command cleanup, log deletion) before they get to the delete. A watcher,
 * a resume's ownership transfer, or a kill can land in that window; deleting on the strength of a
 * stale snapshot would destroy a row that is no longer the row that was examined. The status and
 * the exact ownership bytes are the two fields that decide whether removal is still correct, so
 * both are the fence. `store.js` writes the ownership column only through
 * `serializeOmpSessionOwnership`, whose output is canonical per record, which is what makes a
 * byte comparison an exact "same record" test.
 *
 * @param {string} id
 * @param {{status: string, ompSessionOwnership: object|null}} expected snapshot values
 * @returns {boolean} true when the row was removed
 */
export function removeTaskIfUnchanged(id, expected) {
  const result = getDb()
    .prepare(
      `DELETE FROM tasks
       WHERE id = ? AND status IS ? AND omp_session_ownership IS ?`
    )
    .run(
      id,
      expected?.status ?? null,
      serializeOmpSessionOwnership(expected?.ompSessionOwnership || null)
    );
  return result.changes === 1;
}

/**
 * Clear one row's persisted command-cleanup receipt, and nothing else, only if it is still the
 * exact serialized receipt the caller processed.
 *
 * Deliberately narrower than updateTask(), which is a read-modify-write over every column and
 * would write back whatever the caller's snapshot held for the rest of the row. This is used on
 * the retained path of `clean`, where a concurrent writer may already have installed a new cleanup
 * receipt that must survive.
 *
 * @param {string} id
 * @param {object} expected exact command-cleanup receipt processed by the caller
 * @returns {boolean} true when that exact receipt was cleared
 */
export function clearTaskCommandCleanup(id, expected) {
  const result = getDb()
    .prepare(
      `UPDATE tasks SET command_cleanup = NULL, updated_at = ?
       WHERE id = ? AND command_cleanup IS ?`
    )
    .run(new Date().toISOString(), id, serializeCommandCleanup(expected));
  return result.changes === 1;
}

export function generateId() {
  return generateName('task');
}

export function generateScheduleId() {
  return generateName('sched');
}

// ============================================================================
// Schedules
// ============================================================================

/**
 * Convert DB row to schedule object (camelCase)
 */
function rowToSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    cron: row.cron,
    prompt: row.prompt,
    cwd: row.cwd,
    model: row.model,
    modelLevel: row.model_level,
    reasoningEffort: row.reasoning_effort,
    provider: row.provider,
    enabled: Boolean(row.enabled),
    lastRun: row.last_run,
    nextRun: row.next_run,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Load all schedules as object keyed by id
 * @returns {Object.<string, Object>}
 */
export function loadSchedules() {
  const rows = getDb().prepare('SELECT * FROM schedules ORDER BY created_at DESC').all();
  const schedules = {};
  for (const row of rows) {
    const schedule = rowToSchedule(row);
    schedules[schedule.id] = schedule;
  }
  return schedules;
}

/**
 * Save all schedules (replaces entire store)
 * @param {Object.<string, Object>} schedules
 */
export function saveSchedules(schedules) {
  const database = getDb();
  const insert = database.prepare(`
    INSERT OR REPLACE INTO schedules (
      id, cron, prompt, cwd, model, model_level, reasoning_effort,
      provider, enabled, last_run, next_run, created_at, updated_at
    ) VALUES (
      @id, @cron, @prompt, @cwd, @model, @modelLevel, @reasoningEffort,
      @provider, @enabled, @lastRun, @nextRun, @createdAt, @updatedAt
    )
  `);

  const insertMany = database.transaction((schedulesObj) => {
    database.prepare('DELETE FROM schedules').run();
    for (const schedule of Object.values(schedulesObj)) {
      insert.run({
        id: schedule.id,
        cron: schedule.cron,
        prompt: schedule.prompt,
        cwd: schedule.cwd || null,
        model: schedule.model || null,
        modelLevel: schedule.modelLevel || null,
        reasoningEffort: schedule.reasoningEffort || null,
        provider: schedule.provider || null,
        enabled: schedule.enabled ? 1 : 0,
        lastRun: schedule.lastRun || null,
        nextRun: schedule.nextRun || null,
        createdAt: schedule.createdAt || new Date().toISOString(),
        updatedAt: schedule.updatedAt || new Date().toISOString(),
      });
    }
  });

  insertMany(schedules);
}

/**
 * Get a single schedule by id
 * @param {string} id
 * @returns {Object|null}
 */
export function getSchedule(id) {
  const row = getDb().prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  return rowToSchedule(row);
}

/**
 * Add a new schedule
 * @param {Object} schedule
 * @returns {Object}
 */
export function addSchedule(schedule) {
  const now = new Date().toISOString();
  const fullSchedule = {
    ...schedule,
    createdAt: schedule.createdAt || now,
    updatedAt: schedule.updatedAt || now,
  };

  getDb()
    .prepare(
      `
    INSERT INTO schedules (
      id, cron, prompt, cwd, model, model_level, reasoning_effort,
      provider, enabled, last_run, next_run, created_at, updated_at
    ) VALUES (
      @id, @cron, @prompt, @cwd, @model, @modelLevel, @reasoningEffort,
      @provider, @enabled, @lastRun, @nextRun, @createdAt, @updatedAt
    )
  `
    )
    .run({
      id: fullSchedule.id,
      cron: fullSchedule.cron,
      prompt: fullSchedule.prompt,
      cwd: fullSchedule.cwd || null,
      model: fullSchedule.model || null,
      modelLevel: fullSchedule.modelLevel || null,
      reasoningEffort: fullSchedule.reasoningEffort || null,
      provider: fullSchedule.provider || null,
      enabled: fullSchedule.enabled !== false ? 1 : 0,
      lastRun: fullSchedule.lastRun || null,
      nextRun: fullSchedule.nextRun || null,
      createdAt: fullSchedule.createdAt,
      updatedAt: fullSchedule.updatedAt,
    });

  return fullSchedule;
}

/**
 * Update a schedule
 * @param {string} id
 * @param {Object} updates
 * @returns {Object|null}
 */
export function updateSchedule(id, updates) {
  const existing = getSchedule(id);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  getDb()
    .prepare(
      `
    UPDATE schedules SET
      cron = @cron,
      prompt = @prompt,
      cwd = @cwd,
      model = @model,
      model_level = @modelLevel,
      reasoning_effort = @reasoningEffort,
      provider = @provider,
      enabled = @enabled,
      last_run = @lastRun,
      next_run = @nextRun,
      updated_at = @updatedAt
    WHERE id = @id
  `
    )
    .run({
      id: updated.id,
      cron: updated.cron,
      prompt: updated.prompt,
      cwd: updated.cwd || null,
      model: updated.model || null,
      modelLevel: updated.modelLevel || null,
      reasoningEffort: updated.reasoningEffort || null,
      provider: updated.provider || null,
      enabled: updated.enabled ? 1 : 0,
      lastRun: updated.lastRun || null,
      nextRun: updated.nextRun || null,
      updatedAt: updated.updatedAt,
    });

  return updated;
}

/**
 * Remove a schedule
 * @param {string} id
 */
export function removeSchedule(id) {
  getDb().prepare('DELETE FROM schedules WHERE id = ?').run(id);
}

/**
 * Close the database connection (for cleanup)
 */
export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
