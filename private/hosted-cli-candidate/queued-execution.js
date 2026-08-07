'use strict';

const {
  buildHostedExecution: buildQueuedHostedExecution,
  buildLegacyShipRequest: buildQueuedShipInput,
} = require('./orchestrator-support');

module.exports = { buildQueuedHostedExecution, buildQueuedShipInput };
