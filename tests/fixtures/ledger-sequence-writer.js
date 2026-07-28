const Ledger = require('../../src/ledger');

const [dbPath, clusterId, sender] = process.argv.slice(2);
const ledger = new Ledger(dbPath);

process.send({ type: 'ready' });
process.once('message', ({ timestamp }) => {
  try {
    const message = ledger.append({
      cluster_id: clusterId,
      topic: 'VALIDATION_RESULT',
      sender,
      timestamp,
      content: { text: sender },
    });
    process.send({ type: 'appended', message });
  } catch (error) {
    process.send({ type: 'error', error: error.message });
  } finally {
    ledger.close();
  }
});
