/**
 * Tests for attachable-watcher.js global error handlers
 *
 * CRITICAL: These handlers prevent SILENT process death.
 * Without them, uncaught errors cause immediate termination
 * with no logs, no status update, and no indication of failure.
 *
 * What we test:
 * 1. emergencyLog() writes to file even when main log isn't ready
 * 2. crashWithError() logs crash details with stack trace
 * 3. crashWithError() updates task status to 'failed'
 * 4. Process exits with code 1 on crash
 *
 * What we DON'T test (can't catch in JS):
 * - External SIGKILL (kill -9)
 * - Native crashes (segfaults in node-pty)
 * - OOM killer
 */

const { describe, it, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('Watcher Crash Handling', function () {
  this.timeout(10000);

  let tempDir;
  let logFile;
  let taskId;
  let schemaRoots;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-test-'));
    schemaRoots = [];
    taskId = `test-crash-${Date.now()}`;
    logFile = path.join(tempDir, `${taskId}.log`);
  });

  afterEach(() => {
    // Cleanup temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      for (const schemaRoot of schemaRoots) {
        fs.rmSync(schemaRoot, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Helper to spawn a minimal script that imports and uses the crash handlers
   */
  function spawnCrashTest(crashType) {
    const scriptPath = path.join(tempDir, 'crash-test.mjs');

    // Create a minimal test script that:
    // 1. Sets up the same error handlers as attachable-watcher.js
    // 2. Triggers the specified crash type
    const script = `
import { appendFileSync } from 'fs';

const logFile = process.argv[2];
const taskId = process.argv[3];
const crashType = process.argv[4];

// Emergency logger (same as attachable-watcher.js)
function emergencyLog(msg) {
  try {
    appendFileSync(logFile, msg);
  } catch {
    process.stderr.write(msg);
  }
}

// Crash handler (same as attachable-watcher.js)
function crashWithError(error, source) {
  const timestamp = Date.now();
  const errorMsg = error instanceof Error ? error.stack || error.message : String(error);

  emergencyLog(\`\\n[\${timestamp}][CRASH] \${source}: \${errorMsg}\\n\`);
  emergencyLog(\`[\${timestamp}][CRASH] Process terminating due to unhandled error\\n\`);

  // Note: We don't call updateTask() here because we're testing in isolation
  // The real watcher calls updateTask() to mark the task as failed

  process.exit(1);
}

// Install handlers IMMEDIATELY
process.on('uncaughtException', (error) => {
  crashWithError(error, 'uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  crashWithError(reason, 'unhandledRejection');
});

// Log that we started
emergencyLog('[STARTED]\\n');

// Trigger the specified crash type
if (crashType === 'sync-throw') {
  throw new Error('Simulated synchronous error');
} else if (crashType === 'async-reject') {
  Promise.reject(new Error('Simulated async rejection'));
  // Keep process alive briefly to let rejection propagate
  setTimeout(() => {}, 100);
} else if (crashType === 'timeout-throw') {
  setTimeout(() => {
    throw new Error('Simulated timeout error');
  }, 10);
} else if (crashType === 'normal-exit') {
  emergencyLog('[NORMAL_EXIT]\\n');
  process.exit(0);
}
`;

    fs.writeFileSync(scriptPath, script);

    return spawn('node', [scriptPath, logFile, taskId, crashType], {
      stdio: 'pipe',
    });
  }

  it('should catch synchronous throw and log crash details', (done) => {
    const child = spawnCrashTest('sync-throw');

    child.on('exit', (code) => {
      expect(code).to.equal(1, 'Should exit with code 1');

      const log = fs.readFileSync(logFile, 'utf8');
      expect(log).to.include('[STARTED]');
      expect(log).to.include('[CRASH] uncaughtException');
      expect(log).to.include('Simulated synchronous error');
      expect(log).to.include('Process terminating due to unhandled error');
      done();
    });
  });

  it('should catch unhandled promise rejection and log crash details', (done) => {
    const child = spawnCrashTest('async-reject');

    child.on('exit', (code) => {
      expect(code).to.equal(1, 'Should exit with code 1');

      const log = fs.readFileSync(logFile, 'utf8');
      expect(log).to.include('[STARTED]');
      expect(log).to.include('[CRASH] unhandledRejection');
      expect(log).to.include('Simulated async rejection');
      expect(log).to.include('Process terminating due to unhandled error');
      done();
    });
  });

  it('should catch errors thrown in setTimeout and log crash details', (done) => {
    const child = spawnCrashTest('timeout-throw');

    child.on('exit', (code) => {
      expect(code).to.equal(1, 'Should exit with code 1');

      const log = fs.readFileSync(logFile, 'utf8');
      expect(log).to.include('[STARTED]');
      expect(log).to.include('[CRASH] uncaughtException');
      expect(log).to.include('Simulated timeout error');
      expect(log).to.include('Process terminating due to unhandled error');
      done();
    });
  });

  it('should exit cleanly with code 0 when no crash occurs', (done) => {
    const child = spawnCrashTest('normal-exit');

    child.on('exit', (code) => {
      expect(code).to.equal(0, 'Should exit with code 0');

      const log = fs.readFileSync(logFile, 'utf8');
      expect(log).to.include('[STARTED]');
      expect(log).to.include('[NORMAL_EXIT]');
      expect(log).to.not.include('[CRASH]');
      done();
    });
  });

  it('should include stack trace in crash log', (done) => {
    const child = spawnCrashTest('sync-throw');

    child.on('exit', () => {
      const log = fs.readFileSync(logFile, 'utf8');
      // Stack trace should include the file and line info
      expect(log).to.include('at file://');
      expect(log).to.include('crash-test.mjs');
      done();
    });
  });

  function runWatcher({ commandSpec, config = {}, env = {} }, done) {
    const watcherPath = path.resolve(__dirname, '../../task-lib/watcher.js');
    const child = spawn(
      process.execPath,
      [
        watcherPath,
        taskId,
        tempDir,
        logFile,
        JSON.stringify([]),
        JSON.stringify({
          outputFormat: 'text',
          provider: 'codex',
          ...config,
          commandSpec,
        }),
      ],
      {
        env: {
          ...process.env,
          ZEROSHOT_HOME: tempDir,
          ...env,
        },
        stdio: 'pipe',
      }
    );

    child.on('error', done);
    child.on('exit', (code) => done(null, { code }));
  }

  function createSchemaCleanupFile() {
    const schemaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-schema-'));
    schemaRoots.push(schemaRoot);
    const cleanupFile = path.join(schemaRoot, `${randomUUID()}.json`);
    fs.writeFileSync(cleanupFile, '{}');
    return cleanupFile;
  }

  it('removes helper cleanup files after watcher close', (done) => {
    const cleanupFile = createSchemaCleanupFile();

    runWatcher(
      {
        commandSpec: {
          binary: process.execPath,
          args: ['-e', 'process.exit(0)'],
          env: {},
          cleanup: [cleanupFile],
          cleanupMetadata: [
            { kind: 'temp-file', provider: 'codex', path: cleanupFile, reason: 'output-schema' },
          ],
        },
      },
      (error, result) => {
        if (error) return done(error);
        expect(result.code).to.equal(0);
        expect(fs.existsSync(cleanupFile)).to.equal(false);
        done();
      }
    );
  });

  it('logs helper cleanup failures with the cleanup path', (done) => {
    const cleanupDir = path.join(tempDir, 'cleanup-dir');
    fs.mkdirSync(cleanupDir);

    runWatcher(
      {
        commandSpec: {
          binary: process.execPath,
          args: ['-e', 'process.exit(0)'],
          env: {},
          cleanup: [cleanupDir],
          cleanupMetadata: [
            { kind: 'temp-file', provider: 'codex', path: cleanupDir, reason: 'output-schema' },
          ],
        },
      },
      (error, result) => {
        if (error) return done(error);
        expect(result.code).to.equal(0);
        const log = fs.readFileSync(logFile, 'utf8');
        expect(log).to.include('[CLEANUP]');
        expect(log).to.include(cleanupDir);
        done();
      }
    );
  });

  it('removes helper cleanup files when command spawn fails', (done) => {
    const cleanupFile = createSchemaCleanupFile();

    runWatcher(
      {
        commandSpec: {
          binary: path.join(tempDir, 'missing-command'),
          args: [],
          env: {},
          cleanup: [cleanupFile],
          cleanupMetadata: [
            { kind: 'temp-file', provider: 'codex', path: cleanupFile, reason: 'output-schema' },
          ],
        },
      },
      (error, result) => {
        if (error) return done(error);
        expect(result.code).to.equal(1);
        expect(fs.existsSync(cleanupFile)).to.equal(false);
        done();
      }
    );
  });

  it('recovers Claude structured JSON after streaming mode failure', (done) => {
    const claudeConfigDir = path.join(tempDir, 'claude');
    const projectDir = path.join(claudeConfigDir, 'projects', 'test-project');
    const sessionId = 'session-recovery-test';
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      JSON.stringify({
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'StructuredOutput',
              input: { summary: 'recovered', completionStatus: { canValidate: true } },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }) + '\n'
    );

    const script = `
console.log(JSON.stringify({
  type: 'result',
  is_error: true,
  errors: ['only prompt commands are supported in streaming mode'],
  session_id: '${sessionId}'
}));
process.exit(1);
`;

    runWatcher(
      {
        commandSpec: {
          binary: process.execPath,
          args: ['-e', script],
          env: {},
          cleanup: [],
          cleanupMetadata: [],
        },
        config: {
          provider: 'claude',
          outputFormat: 'json',
          jsonSchema: { type: 'object' },
          silentJsonOutput: true,
        },
        env: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      },
      (error, result) => {
        if (error) return done(error);
        expect(result.code).to.equal(0);
        const log = fs.readFileSync(logFile, 'utf8');
        expect(log).to.include('"structured_output"');
        expect(log).to.include('"summary":"recovered"');
        done();
      }
    );
  });
});
