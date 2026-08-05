'use strict';

async function withInterruptSignal(operation) {
  const abort = new AbortController();
  const onSigint = () =>
    abort.abort(new globalThis.DOMException('remote observation interrupted', 'AbortError'));
  process.once('SIGINT', onSigint);
  try {
    return await operation(abort.signal);
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

module.exports = { withInterruptSignal };
