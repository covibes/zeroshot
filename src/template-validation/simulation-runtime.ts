interface SimulationLedger {
  close(): void;
}

interface SimulationMessageBus {
  publish(message: unknown): unknown;
  findLast(criteria: unknown): unknown;
}

interface SimulationLogicEngine {
  evaluate(script: string, agent: unknown, message: unknown): boolean;
}

interface LedgerConstructor {
  new (databasePath: string): SimulationLedger;
}

interface MessageBusConstructor {
  new (ledger: SimulationLedger): SimulationMessageBus;
}

interface LogicEngineConstructor {
  new (messageBus: SimulationMessageBus, cluster: unknown): SimulationLogicEngine;
}

interface SimulationRuntime {
  ledger: SimulationLedger;
  messageBus: SimulationMessageBus;
  logicEngine: SimulationLogicEngine;
}

function isLedgerConstructor(value: unknown): value is LedgerConstructor {
  return typeof value === 'function';
}

function isMessageBusConstructor(value: unknown): value is MessageBusConstructor {
  return typeof value === 'function';
}

function isLogicEngineConstructor(value: unknown): value is LogicEngineConstructor {
  return typeof value === 'function';
}

const ledgerModule: unknown = require('../ledger');
const messageBusModule: unknown = require('../message-bus');
const logicEngineModule: unknown = require('../logic-engine');

if (!isLedgerConstructor(ledgerModule)) {
  throw new TypeError('ledger must export a constructor');
}
if (!isMessageBusConstructor(messageBusModule)) {
  throw new TypeError('message-bus must export a constructor');
}
if (!isLogicEngineConstructor(logicEngineModule)) {
  throw new TypeError('logic-engine must export a constructor');
}

const Ledger = ledgerModule;
const MessageBus = messageBusModule;
const LogicEngine = logicEngineModule;

function createSimulationRuntime(cluster: unknown): SimulationRuntime {
  const ledger = new Ledger(':memory:');
  const messageBus = new MessageBus(ledger);
  const logicEngine = new LogicEngine(messageBus, cluster);
  return { ledger, messageBus, logicEngine };
}

export = {
  createSimulationRuntime,
};
