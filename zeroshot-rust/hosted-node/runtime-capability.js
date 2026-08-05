'use strict';

const fs = require('node:fs');
const net = require('node:net');

const CAPABILITY_ENV = 'ZEROSHOT_OECP_RUNTIME_CAPABILITY';
const CAPABILITY_FILE_ENV = 'ZEROSHOT_OECP_CAPABILITY_FILE';
const CAPABILITY_BOOTSTRAP_ENV = 'ZEROSHOT_OECP_CAPABILITY_BOOTSTRAP';
const LOOPBACK_BOOTSTRAP_MODE = 'loopback-v1';
const LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_PORT = 8086;
const CAPABILITY_BYTES = 64;
const BOOTSTRAP_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 2_000;
const BOOTSTRAP_ACK = Buffer.from('OK\n', 'ascii');

function capabilityFile(environment) {
  const value = environment[CAPABILITY_FILE_ENV];
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new Error('Hosted runtime capability configuration is invalid');
  }
  return value;
}

function validCapability(value) {
  if (typeof value === 'string') return /^[0-9a-f]{64}$/.test(value);
  return (
    Buffer.isBuffer(value) &&
    value.length === CAPABILITY_BYTES &&
    value.every((byte) => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66))
  );
}

function writeRuntimeCapability(value, environment) {
  if (!validCapability(value)) {
    throw new Error('Hosted runtime capability configuration is invalid');
  }
  fs.writeFileSync(capabilityFile(environment), value, {
    flag: 'wx',
    mode: 0o400,
  });
}

function installRuntimeCapability(environment = process.env) {
  writeRuntimeCapability(environment[CAPABILITY_ENV], environment);
  delete environment[CAPABILITY_ENV];
}

function readBootstrapCapability(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    let settled = false;
    function fail() {
      if (settled) return;
      settled = true;
      received.fill(0);
      socket.destroy();
      reject(new Error('Hosted runtime capability bootstrap failed'));
    }
    socket.setTimeout(timeoutMs, fail);
    socket.on('data', (chunk) => {
      if (settled || received.length + chunk.length > CAPABILITY_BYTES) {
        chunk.fill(0);
        fail();
        return;
      }
      const next = Buffer.concat([received, chunk]);
      received.fill(0);
      chunk.fill(0);
      received = next;
    });
    socket.once('end', () => {
      if (!validCapability(received)) {
        fail();
        return;
      }
      settled = true;
      socket.setTimeout(0);
      resolve(received);
    });
    socket.once('close', fail);
    socket.once('error', fail);
  });
}

function receiveRuntimeCapability(environment, options = {}) {
  capabilityFile(environment);
  const host = options.host ?? LOOPBACK_HOST;
  const port = options.port ?? LOOPBACK_PORT;
  const timeoutMs = options.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS;
  const connectionTimeoutMs = options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let activeSocket;
    let claimed = false;
    let settled = false;
    let server;
    let timer;
    function closeListener() {
      if (server.listening) server.close();
    }
    function stop() {
      clearTimeout(timer);
      closeListener();
    }
    function fail(cause) {
      if (settled) return;
      settled = true;
      stop();
      activeSocket?.destroy();
      reject(new Error('Hosted runtime capability bootstrap failed', { cause }));
    }
    function succeed(socket) {
      if (settled) return;
      settled = true;
      stop();
      socket.end(BOOTSTRAP_ACK);
      resolve();
    }
    server = net.createServer({ allowHalfOpen: true }, async (socket) => {
      if (settled || claimed) {
        socket.destroy();
        return;
      }
      claimed = true;
      activeSocket = socket;
      closeListener();
      let capability;
      try {
        capability = await readBootstrapCapability(socket, connectionTimeoutMs);
        writeRuntimeCapability(capability, environment);
        delete environment[CAPABILITY_BOOTSTRAP_ENV];
        succeed(socket);
      } catch (error) {
        fail(error);
      } finally {
        capability?.fill(0);
      }
    });
    server.on('error', fail);
    server.listen({ host, port, exclusive: true }, () => {
      try {
        options.onListening?.(server.address());
      } catch (error) {
        fail(error);
      }
    });
    timer = setTimeout(fail, timeoutMs);
  });
}

async function provisionRuntimeCapability(environment = process.env, options = {}) {
  const direct = environment[CAPABILITY_ENV] !== undefined;
  const bootstrap = environment[CAPABILITY_BOOTSTRAP_ENV];
  if (direct && bootstrap === undefined) {
    installRuntimeCapability(environment);
    return;
  }
  if (!direct && bootstrap === LOOPBACK_BOOTSTRAP_MODE) {
    await receiveRuntimeCapability(environment, options);
    return;
  }
  throw new Error('Hosted runtime capability configuration is invalid');
}

module.exports = {
  LOOPBACK_BOOTSTRAP_MODE,
  installRuntimeCapability,
  provisionRuntimeCapability,
};
