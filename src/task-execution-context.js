'use strict';

const TASK_EXECUTION_CONTEXT_ENV = 'ZEROSHOT_TASK_EXECUTION_CONTEXT';
const TASK_EXECUTION_CONTEXTS = Object.freeze(['host', 'detached', 'docker', 'benchmark']);
const taskExecutionContexts = new Set(TASK_EXECUTION_CONTEXTS);

function resolveTaskExecutionContext(environment = process.env) {
  const context = environment[TASK_EXECUTION_CONTEXT_ENV];
  if (context === undefined) return 'detached';
  if (!taskExecutionContexts.has(context)) {
    throw new Error(
      `${TASK_EXECUTION_CONTEXT_ENV} must be one of: ${TASK_EXECUTION_CONTEXTS.join(', ')}.`
    );
  }
  return context;
}

module.exports = {
  TASK_EXECUTION_CONTEXT_ENV,
  TASK_EXECUTION_CONTEXTS,
  resolveTaskExecutionContext,
};
