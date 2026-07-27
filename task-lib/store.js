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

const DB_FILE = join(TASKS_DIR, 'store.db');

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
      command_cleanup TEXT
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

  ensureTaskColumn(db, 'process_group_id', 'INTEGER');
  ensureTaskColumn(db, 'termination_strategy', 'TEXT');
  ensureTaskColumn(db, 'command_cleanup', 'TEXT');

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
  return {
    id: row.id,
    prompt: row.prompt,
    fullPrompt: row.full_prompt,
    cwd: row.cwd,
    status: row.status,
    pid: row.pid,
    sessionId: row.session_id,
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
  };
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
 * Save all tasks (replaces entire store - for migration compatibility)
 * @param {Object.<string, Object>} tasks
 */
export function saveTasks(tasks) {
  const database = getDb();
  const insert = database.prepare(`
    INSERT OR REPLACE INTO tasks (
      id, prompt, full_prompt, cwd, status, pid, session_id, log_file,
      created_at, updated_at, exit_code, error, provider, model,
      schedule_id, socket_path, attachable, process_group_id, termination_strategy,
      command_cleanup
    ) VALUES (
      @id, @prompt, @fullPrompt, @cwd, @status, @pid, @sessionId, @logFile,
      @createdAt, @updatedAt, @exitCode, @error, @provider, @model,
      @scheduleId, @socketPath, @attachable, @processGroupId, @terminationStrategy,
      @commandCleanup
    )
  `);

  const insertMany = database.transaction((tasksObj) => {
    // Clear existing
    database.prepare('DELETE FROM tasks').run();
    // Insert all
    for (const task of Object.values(tasksObj)) {
      insert.run({
        id: task.id,
        prompt: task.prompt || null,
        fullPrompt: task.fullPrompt || null,
        cwd: task.cwd || null,
        status: task.status || 'pending',
        pid: task.pid || null,
        sessionId: task.sessionId || null,
        logFile: task.logFile || null,
        createdAt: task.createdAt || new Date().toISOString(),
        updatedAt: task.updatedAt || new Date().toISOString(),
        exitCode: task.exitCode ?? null,
        error: task.error || null,
        provider: task.provider || null,
        model: task.model || null,
        scheduleId: task.scheduleId || null,
        socketPath: task.socketPath || null,
        attachable: task.attachable ? 1 : 0,
        processGroupId: task.processGroupId || null,
        terminationStrategy: task.terminationStrategy || null,
        commandCleanup: serializeCommandCleanup(task.commandCleanup),
      });
    }
  });

  insertMany(tasks);
}

/**
 * For API compatibility - just runs the modifier synchronously
 * SQLite WAL handles concurrency, no lock needed
 * @param {Function} modifier
 * @returns {any}
 */
export function withTasksLock(modifier) {
  const tasks = loadTasks();
  const result = modifier(tasks);
  saveTasks(tasks);
  return result;
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
      command_cleanup = @commandCleanup
    WHERE id = @id
  `
    )
    .run({
      id: updated.id,
      prompt: updated.prompt || null,
      fullPrompt: updated.fullPrompt || null,
      cwd: updated.cwd || null,
      status: updated.status || 'pending',
      pid: updated.pid || null,
      sessionId: updated.sessionId || null,
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
    });

  return updated;
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
      id, prompt, full_prompt, cwd, status, pid, session_id, log_file,
      created_at, updated_at, exit_code, error, provider, model,
      schedule_id, socket_path, attachable, process_group_id, termination_strategy,
      command_cleanup
    ) VALUES (
      @id, @prompt, @fullPrompt, @cwd, @status, @pid, @sessionId, @logFile,
      @createdAt, @updatedAt, @exitCode, @error, @provider, @model,
      @scheduleId, @socketPath, @attachable, @processGroupId, @terminationStrategy,
      @commandCleanup
    )
  `
    )
    .run({
      id: fullTask.id,
      prompt: fullTask.prompt || null,
      fullPrompt: fullTask.fullPrompt || null,
      cwd: fullTask.cwd || null,
      status: fullTask.status || 'pending',
      pid: fullTask.pid || null,
      sessionId: fullTask.sessionId || null,
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
    });

  return fullTask;
}

/**
 * Remove a task
 * @param {string} id
 */
export function removeTask(id) {
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
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
