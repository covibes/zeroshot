/**
 * Attach endpoint resolution.
 *
 * On Unix a socket path plays two roles at once: it is the address `net` binds
 * to, and it is the on-disk record that readdir-based discovery, staleness
 * cleanup and cluster teardown operate on. The `.sock` node is both.
 *
 * Windows has no filesystem-visible Unix domain sockets. Named pipes live in a
 * separate `\\.\pipe\` namespace that cannot be enumerated, stat-ed or unlinked
 * through `fs`, so binding a pipe would silently break every discovery and
 * cleanup path that assumes a file exists.
 *
 * So on Windows the two roles are split, and only the address changes:
 *
 *   record   - a regular file at the same `.sock` path. Discovery, staleness
 *              cleanup and directory teardown keep working untouched.
 *   endpoint - a named pipe derived deterministically from the record path, so
 *              every process resolves the same name without reading the record
 *              (no parse step, no read/write race on startup).
 *
 * Liveness keeps its existing shape on both platforms: the record says an
 * endpoint was claimed, a connect attempt says whether anything still serves
 * it. A dead process leaves a record that fails to connect, which is exactly
 * the stale-socket case cleanup already handles.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
const PIPE_PREFIX = '\\\\.\\pipe\\';
const RECORD_MODE = 0o600;

/**
 * Derive the pipe name for a record path. Windows paths are case-insensitive,
 * so the key is lowercased to keep two spellings of one path on one pipe.
 * The digest also keeps the name inside the pipe namespace length limit no
 * matter how long the record path is.
 */
function pipeNameFor(recordPath: string): string {
  const key = path.resolve(recordPath).toLowerCase();
  const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
  return `${PIPE_PREFIX}zeroshot-${digest}`;
}

/** Address to bind or connect for a given record path. */
export function endpointFor(recordPath: string): string {
  return IS_WINDOWS ? pipeNameFor(recordPath) : recordPath;
}

/**
 * Create the discovery record. No-op on Unix, where binding the socket creates
 * the node itself. Callers must treat failure as a startup failure: a served
 * pipe with no record is invisible to `listAttachableTasks`.
 */
export function writeEndpointRecord(recordPath: string): void {
  if (!IS_WINDOWS) return;
  fs.writeFileSync(recordPath, `${pipeNameFor(recordPath)}\n`, { mode: RECORD_MODE });
}

export { IS_WINDOWS };

/** Socket type for callers that no longer import `net` directly. */
export type EndpointSocket = net.Socket;

/**
 * Connect to the endpoint backing a record path. Callers go through this rather
 * than `net.createConnection` so an untranslated record path cannot reach the
 * wire on Windows.
 */
export function connectToEndpoint(recordPath: string): EndpointSocket {
  return net.createConnection(endpointFor(recordPath));
}
