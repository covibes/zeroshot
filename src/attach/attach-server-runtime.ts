import type { AttachServerHost } from './attach-server-types';

export async function stopPty(host: AttachServerHost, signal: string): Promise<void> {
  if (host.state !== 'running') return;
  host.state = 'exiting';
  try {
    host.pty?.kill(signal);
  } catch {
    // Process may already be dead.
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      try {
        host.pty?.kill('SIGKILL');
      } catch {
        // Ignore force-kill failures.
      }
      resolve();
    }, 5000);
    const checkExit = (): void => {
      if (host.state === 'exited') {
        clearTimeout(timeout);
        resolve();
      } else {
        setTimeout(checkExit, 100);
      }
    };
    checkExit();
  });
  await host._cleanup();
}

export function sendPtySignal(host: AttachServerHost, signal: string): boolean {
  if (!host.pty || host.state !== 'running') return false;
  try {
    host.pty.kill(signal);
    return true;
  } catch {
    return false;
  }
}

export function resizePty(host: AttachServerHost, cols: number, rows: number): void {
  if (!host.pty || host.state !== 'running') return;
  host.cols = cols;
  host.rows = rows;
  try {
    host.pty.resize(cols, rows);
  } catch {
    // Ignore resize errors.
  }
}

export function writePty(host: AttachServerHost, data: Buffer | string): boolean {
  if (!host.pty || host.state !== 'running') return false;
  try {
    host.pty.write(data);
    return true;
  } catch {
    return false;
  }
}
