const fs = require('node:fs');
const path = require('node:path');

const {
  parseRecords,
  runCliTaskExport,
  withLogWorkspace,
} = require('./helpers/cluster-export-fixtures');
const { semanticFixture, semanticTask } = require('./helpers/semantic-export-fixtures');

it(
  'exports semantic JSONL through the public CLI',
  withLogWorkspace('zeroshot-semantic-cli-', (root) => {
    const homeDir = path.join(root, 'home');
    const clusterId = 'semantic-cli-cluster';
    const taskId = 'task-semantic-cli';
    const logRoot = path.join(homeDir, '.claude-zeroshot', 'logs');
    const logFile = path.join(logRoot, `${taskId}.log`);
    const outputPath = path.join(root, 'cli.semantic.jsonl');
    fs.mkdirSync(path.join(homeDir, '.zeroshot'), { recursive: true });
    fs.mkdirSync(logRoot, { recursive: true });
    fs.writeFileSync(logFile, semanticFixture('codex'));
    runCliTaskExport({
      homeDir,
      clusterId,
      taskId,
      task: semanticTask(taskId, 'codex', logFile),
      format: 'semantic',
      outputPath,
    });
    const records = parseRecords(outputPath);
    if (records[0].schema_version !== 'zeroshot.semantic.v1' || !records.at(-1).complete) {
      throw new Error('Semantic CLI export was not complete');
    }
  })
);
