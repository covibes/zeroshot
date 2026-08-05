#!/usr/bin/env node

import { spawnTask } from '../../task-lib/runner.js';

const task = spawnTask(process.env.OMP_SDK_TASK_PROMPT, { provider: 'omp' });
process.stdout.write(
  JSON.stringify({
    id: task.id,
    logFile: task.logFile,
    commandCleanup: task.commandCleanup,
    ompSessionOwnership: task.ompSessionOwnership,
  })
);
