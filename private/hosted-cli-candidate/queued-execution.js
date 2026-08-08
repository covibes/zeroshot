'use strict';

const { buildLegacyShipRequest: buildQueuedShipInput } = require('./orchestrator-support');

function buildQueuedHostedExecution(inputs) {
  return Object.freeze({
    graph: inputs.graph,
    input: buildQueuedShipInput(inputs.input),
  });
}

module.exports = { buildQueuedHostedExecution, buildQueuedShipInput };
