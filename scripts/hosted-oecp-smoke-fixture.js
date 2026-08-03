'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');

const SOCKET_ROOT = '/run/zeroshot-capsule-agent';
const PROXY_SOCKET = `${SOCKET_ROOT}/proxy.sock`;
const DELIVERY_SOCKET = `${SOCKET_ROOT}/delivery.sock`;

function listenSocket(socketPath, respond) {
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const server = net.createServer({ allowHalfOpen: true }, (stream) => {
    server.close();
    let frame = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      frame += chunk;
      if (Buffer.byteLength(frame) > 4096) stream.destroy();
    });
    stream.on('end', () => {
      try {
        stream.end(`${JSON.stringify(respond(JSON.parse(frame)))}\n`);
      } catch {
        stream.destroy();
      }
    });
  });
  server.listen(socketPath);
  return server;
}

function hostedWorkerExists() {
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const command = fs.readFileSync(`/proc/${name}/cmdline`);
      if (command.includes(Buffer.from('/hosted-node/worker.js'))) return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

let proxyCleaned = false;
let deliveryCalls = 0;
let proxyTurns = 0;
const proxy = http.createServer((request, response) => {
  const chunks = [];
  let bytes = 0;
  request.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) request.destroy();
    else chunks.push(chunk);
  });
  request.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      if (
        request.method !== 'POST' ||
        request.url !== '/v1/chat/completions' ||
        request.headers.authorization !== 'Bearer zeroshot-capsule-sentinel' ||
        body.model !== 'zeroshot-capsule-model'
      ) {
        throw new Error('worker crossed the fixed proxy boundary');
      }
      proxyTurns += 1;
      const message =
        proxyTurns === 1
          ? {
              content: null,
              tool_calls: [
                {
                  id: 'hosted-smoke-write',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({
                      path: 'hosted-smoke-output.txt',
                      content: 'process-derived hosted smoke output\n',
                    }),
                  },
                },
              ],
            }
          : { content: 'Workspace change complete.' };
      setTimeout(
        () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message }] }));
        },
        proxyTurns === 1 ? 50 : 750
      );
    } catch {
      response.writeHead(400);
      response.end();
    }
  });
});

fs.mkdirSync(SOCKET_ROOT, { recursive: true, mode: 0o700 });
listenSocket(PROXY_SOCKET, (request) => {
  if (request.version !== 1 || request.operation !== 'stop_and_cleanup') {
    throw new Error('invalid proxy cleanup request');
  }
  proxyCleaned = true;
  return {
    version: 1,
    admissionStopped: true,
    credentialsCleaned: true,
  };
});
listenSocket(DELIVERY_SOCKET, (request) => {
  deliveryCalls += 1;
  if (
    request.version !== 1 ||
    request.operation !== 'deliver' ||
    deliveryCalls !== 1 ||
    !proxyCleaned ||
    hostedWorkerExists()
  ) {
    throw new Error('delivery ordering failed');
  }
  return {
    version: 1,
    receipt: {
      deliveryId: request.intent.deliveryId,
      reviewRef: 'review:hosted-smoke',
    },
  };
});
proxy.listen(8081, '127.0.0.1', () => process.stdout.write('fixture-ready\n'));
