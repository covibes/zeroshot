const EventEmitter = require('node:events');
const { PassThrough } = require('node:stream');

function isolatedTailProcess() {
  const processHandle = new EventEmitter();
  processHandle.stdout = new PassThrough();
  processHandle.stderr = new PassThrough();
  processHandle.kill = () => {};
  return processHandle;
}

function isolatedTailManager(raw, status) {
  return {
    spawnInContainer: () => isolatedTailProcess(),
    execInContainer(_clusterId, command) {
      const rendered = command.join(' ');
      if (rendered.includes('get-log-path')) {
        return Promise.resolve({ code: 0, stdout: '/tmp/final.log\n', stderr: '' });
      }
      if (rendered.includes('zeroshot status')) {
        return Promise.resolve({ code: 0, stdout: `Status: ${status}\n`, stderr: '' });
      }
      if (rendered.includes('wc -c')) {
        return Promise.resolve({ code: 0, stdout: `${Buffer.byteLength(raw)}\n`, stderr: '' });
      }
      if (rendered.includes('tail -c')) {
        return Promise.resolve({ code: 0, stdout: raw, stderr: '' });
      }
      return Promise.reject(new Error(`Unexpected isolated command: ${rendered}`));
    },
  };
}

function isolatedAgent(providerName, manager, published = []) {
  return {
    id: 'isolated-final-worker',
    role: 'implementation',
    iteration: 1,
    running: true,
    config: { outputFormat: 'text', cwd: process.cwd() },
    cluster: { id: 'isolated-final' },
    isolation: { manager, clusterId: 'isolated-final' },
    messageBus: { publish: (message) => published.push(message) },
    _resolveProvider: () => providerName,
    _log() {},
    _stopLivenessCheck() {},
  };
}

module.exports = { isolatedAgent, isolatedTailManager };
