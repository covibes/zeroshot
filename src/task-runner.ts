interface TaskRunnerOptions {
  agentId: string;
  model: string;
  provider?: string;
  modelSpec?: object;
  outputFormat?: string;
  jsonSchema?: object;
  cwd?: string;
  isolation?: boolean;
}

interface TaskRunnerResult {
  success: boolean;
  output: string;
  error: string | null;
  taskId?: string;
}

/**
 * TaskRunner - Strategy Pattern interface for executing provider tasks.
 */
class TaskRunner {
  run(_context: string, _options: TaskRunnerOptions): Promise<TaskRunnerResult> {
    throw new Error('TaskRunner.run() not implemented');
  }
}

export = TaskRunner;
