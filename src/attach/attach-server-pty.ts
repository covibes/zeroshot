import { createRequire } from 'node:module';

import type { AttachServerHost, PtyProcess } from './attach-server-types';

interface PtyModule {
  spawn(
    command: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
    }
  ): unknown;
}

const requireFromHere = createRequire(__filename);
let ptyModule: unknown;
try {
  ptyModule = requireFromHere('node-pty');
} catch (error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  throw new Error(
    `AttachServer: node-pty not installed. Run: npm install node-pty\nOriginal error: ${reason}`
  );
}

function isPtyModule(value: unknown): value is PtyModule {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof Reflect.get(value, 'spawn') === 'function'
  );
}

function isPtyProcess(value: unknown): value is PtyProcess {
  if (typeof value !== 'object' || value === null) return false;
  return (
    typeof Reflect.get(value, 'pid') === 'number' &&
    typeof Reflect.get(value, 'kill') === 'function' &&
    typeof Reflect.get(value, 'resize') === 'function' &&
    typeof Reflect.get(value, 'write') === 'function' &&
    typeof Reflect.get(value, 'onData') === 'function' &&
    typeof Reflect.get(value, 'onExit') === 'function'
  );
}

export function spawnPty(host: AttachServerHost): void {
  if (!isPtyModule(ptyModule)) throw new TypeError('pty.spawn is not a function');
  const process = ptyModule.spawn(host.command, host.args, {
    name: 'xterm-256color',
    cols: host.cols,
    rows: host.rows,
    cwd: host.cwd,
    env: host.env,
  });
  if (!isPtyProcess(process)) throw new TypeError('node-pty returned an invalid process');
  host.pty = process;
  host.pid = process.pid;
  process.onData((data) => host._handlePtyOutput(data));
  process.onExit(({ exitCode, signal }) => host._onProcessExit(exitCode, signal));
}
