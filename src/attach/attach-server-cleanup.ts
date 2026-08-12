import fs from 'node:fs';
import path from 'node:path';

import type { AttachServerHost } from './attach-server-types';

export async function cleanupAttachServer(host: AttachServerHost): Promise<void> {
  for (const [, client] of host.clients) {
    try {
      client.socket.destroy();
    } catch {
      // Ignore client cleanup failures.
    }
  }
  host.clients.clear();

  if (host.server) {
    const server = host.server;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    host.server = null;
  }

  if (fs.existsSync(host.socketPath)) {
    try {
      fs.unlinkSync(host.socketPath);
    } catch {
      // Ignore socket cleanup failures.
    }
  }

  const socketDir = path.dirname(host.socketPath);
  if (socketDir.includes('cluster-')) {
    try {
      if (fs.readdirSync(socketDir).length === 0) fs.rmdirSync(socketDir);
    } catch {
      // Ignore directory cleanup failures.
    }
  }
  host.emit('cleanup');
}
