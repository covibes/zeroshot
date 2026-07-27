const fs = require('fs');
const os = require('os');
const path = require('path');

const AgentWrapper = require('../../src/agent-wrapper');
const Ledger = require('../../src/ledger');
const MessageBus = require('../../src/message-bus');

function createProviderSessionHarness(prefix) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const settingsSnapshot = {
    existed: Object.hasOwn(process.env, 'ZEROSHOT_SETTINGS_FILE'),
    value: process.env.ZEROSHOT_SETTINGS_FILE,
  };
  process.env.ZEROSHOT_SETTINGS_FILE = path.join(tempDir, 'settings.json');
  fs.writeFileSync(
    process.env.ZEROSHOT_SETTINGS_FILE,
    JSON.stringify({ backoffBaseMs: 0, backoffMaxMs: 0, jitterFactor: 0 })
  );
  const ledger = new Ledger(path.join(tempDir, 'ledger.db'));

  return {
    ledger,
    messageBus: new MessageBus(ledger),
    cleanup() {
      ledger.close();
      if (settingsSnapshot.existed) {
        process.env.ZEROSHOT_SETTINGS_FILE = settingsSnapshot.value;
      } else {
        delete process.env.ZEROSHOT_SETTINGS_FILE;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function createProviderSessionAgent({ cluster, messageBus, config = {}, runtime = {} }) {
  return new AgentWrapper(
    {
      id: 'worker',
      role: 'implementation',
      provider: 'claude',
      timeout: 0,
      contextStrategy: { sources: [] },
      ...config,
    },
    messageBus,
    cluster,
    {
      testMode: true,
      mockSpawnFn: () => ({ success: true, output: '{}' }),
      ...runtime,
    }
  );
}

module.exports = {
  createProviderSessionAgent,
  createProviderSessionHarness,
};
