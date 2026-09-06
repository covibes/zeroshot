import fs from 'node:fs';
import net from 'node:net';

import { IS_WINDOWS, endpointFor, writeEndpointRecord } from './socket-endpoint';
import type { AttachServerHost } from './attach-server-types';

export function startSocketServer(host: AttachServerHost): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => host._handleClientConnection(socket));
    host.server = server;
    server.on('error', host._onServerError);
    server.listen(endpointFor(host.socketPath), () => {
      if (IS_WINDOWS) {
        // The pipe carries the connection, but discovery and cleanup only see
        // the record, so a failure here leaves an unreachable server: reject.
        try {
          writeEndpointRecord(host.socketPath);
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        resolve();
        return;
      }
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
