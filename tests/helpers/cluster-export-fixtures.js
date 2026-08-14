const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Ledger = require('../../src/ledger');

function fakeLedger(messages) {
  return { iterateAll: () => messages[Symbol.iterator]() };
}

function lifecycle(sequence, taskId, agentId, clusterId = 'trace-cluster') {
  return {
    id: `message-${sequence}`,
    sequence: String(sequence),
    timestamp: 1800000000000 + sequence,
    topic: 'AGENT_LIFECYCLE',
    sender: agentId,
    receiver: 'broadcast',
    cluster_id: clusterId,
    content: { data: { event: 'TASK_ID_ASSIGNED', taskId } },
  };
}

function parseRecords(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function taskOutput(records, taskId) {
  return Buffer.concat(
    records
      .filter((record) => record.record_type === 'task_output_chunk' && record.task_id === taskId)
      .map((record) => Buffer.from(record.data_base64, 'base64'))
  );
}

function traceTask(taskId, provider, prompt, logFile) {
  return {
    id: taskId,
    fullPrompt: prompt,
    prompt: prompt.slice(0, 200),
    status: 'completed',
    createdAt: '2026-08-14T12:00:00.000Z',
    updatedAt: '2026-08-14T12:01:00.000Z',
    exitCode: 0,
    provider,
    model: `${provider}-model`,
    logFile,
  };
}

function withLogWorkspace(prefix, run) {
  return function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const logRoot = path.join(root, 'logs');
    fs.mkdirSync(logRoot);
    try {
      run(root, logRoot);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function protectedOutputs(root, extension) {
  const protectedPath = path.join(root, 'protected.txt');
  const existing = path.join(root, `existing.${extension}`);
  const symlink = path.join(root, `symlink.${extension}`);
  fs.writeFileSync(protectedPath, 'protected');
  fs.writeFileSync(existing, 'existing');
  fs.symlinkSync(protectedPath, symlink);
  return { existing, protectedPath, symlink };
}

function sourceBoundary(root, logRoot, suffix, protectedContent, changingContent) {
  const protectedPath = path.join(root, 'protected-source.txt');
  const symlinkLog = path.join(logRoot, `task-symlink-source.log`);
  const changingLog = path.join(logRoot, `task-changing-source.log`);
  const outputPath = path.join(root, `source-boundary.${suffix}`);
  fs.writeFileSync(protectedPath, protectedContent);
  fs.symlinkSync(protectedPath, symlinkLog);
  fs.writeFileSync(changingLog, changingContent);
  return { changingLog, outputPath, protectedPath, symlinkLog };
}

function withReadMutation(targetPath, afterReads, appended, run) {
  const originalReadSync = fs.readSync;
  let reads = 0;
  fs.readSync = function (...args) {
    const bytes = originalReadSync.apply(this, args);
    reads += 1;
    if (reads === afterReads) fs.appendFileSync(targetPath, appended);
    return bytes;
  };
  try {
    run();
  } finally {
    fs.readSync = originalReadSync;
  }
}

function runCliTaskExport({ homeDir, clusterId, taskId, task, format, outputPath }) {
  const ledger = new Ledger(path.join(homeDir, '.zeroshot', `${clusterId}.db`));
  ledger.append({
    cluster_id: clusterId,
    topic: 'AGENT_LIFECYCLE',
    sender: 'cli-agent',
    content: { data: { event: 'TASK_ID_ASSIGNED', taskId } },
  });
  ledger.close();
  const environment = { ...process.env, HOME: homeDir, ZEROSHOT_HOME: homeDir };
  const addTask = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { addTask } from './task-lib/store.js'; addTask(${JSON.stringify(task)});`,
    ],
    { cwd: path.join(__dirname, '..', '..'), env: environment, encoding: 'utf8' }
  );
  assertSuccessful(addTask);
  const exported = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '..', '..', 'cli', 'index.js'),
      'export',
      clusterId,
      '-f',
      format,
      '-o',
      outputPath,
    ],
    { env: environment, encoding: 'utf8' }
  );
  assertSuccessful(exported);
}

function assertSuccessful(result) {
  if (result.status !== 0)
    throw new Error(result.stderr || result.stdout || `exit ${result.status}`);
}

module.exports = {
  fakeLedger,
  lifecycle,
  parseRecords,
  protectedOutputs,
  runCliTaskExport,
  sourceBoundary,
  taskOutput,
  traceTask,
  withLogWorkspace,
  withReadMutation,
};
