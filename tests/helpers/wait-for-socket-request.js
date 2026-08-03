'use strict';

async function waitForSocketRequest(socket, method) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const request = socket.request(method);
    if (request) return request;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${method} request`);
}

module.exports = { waitForSocketRequest };
