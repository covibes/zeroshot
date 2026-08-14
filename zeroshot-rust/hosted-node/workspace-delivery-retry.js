'use strict';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runBoundedReconciledOperation(options) {
  const wait = options.wait || delay;
  let lastError;

  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    let operationError;
    try {
      return await options.operation();
    } catch (error) {
      operationError = error;
    }

    try {
      const reconciliation = await options.reconcile(operationError);
      if (reconciliation.done) return reconciliation.value;
      if (!options.retryable(operationError)) throw operationError;
      lastError = operationError;
    } catch (reconciliationError) {
      if (!options.retryable(operationError) || !options.retryable(reconciliationError)) {
        throw new AggregateError(
          [operationError, reconciliationError],
          'Operation reconciliation failed'
        );
      }
      lastError = new AggregateError([operationError, reconciliationError]);
    }

    if (attempt + 1 < options.attempts) await wait(options.intervalMs);
  }
  throw new Error(options.exhaustedMessage, { cause: lastError });
}

module.exports = { runBoundedReconciledOperation };
