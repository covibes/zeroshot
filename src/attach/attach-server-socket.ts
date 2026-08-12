import fs from 'node:fs';
import net from 'node:net';

import type { AttachServerHost } from './attach-server-types';

export function startSocketServer(host: AttachServerHost): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => host._handleClientConnection(socket));
    host.server = server;
    server.on('error', host._onServerError);
    server.listen(host.socketPath, () => {
      try {
        fs.chmodSync(host.socketPath, 0o600);
      } catch {
        // Ignore permission errors.
      }
      resolve();
    });
    server.on('error', (error: Error) => {
      if (host.state === 'starting') reject(error);
    });
  });
}
