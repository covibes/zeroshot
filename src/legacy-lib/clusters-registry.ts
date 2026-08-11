/**
 * Single read/write path for clusters.json.
 *
 * All callers that need the raw registry (Orchestrator, id-detector, gc,
 * socket-discovery, CLI) go through readClustersFileSync/writeClustersFileAtomic
 * instead of ad-hoc JSON.parse(fs.readFileSync(...)) / fs.writeFileSync(...).
 *
 * Writes are atomic (temp file + rename) so a reader can never observe a
 * partially-written file, even without taking the write lock. Callers that
 * read-modify-write (Orchestrator._saveClusters) still need proper-lockfile
 * around the whole operation to avoid losing concurrent updates.
 */

import fs = require('fs');
import path = require('path');

function clustersFilePath(storageDir: string): string {
  return path.join(storageDir, 'clusters.json');
}

/** Read clusters.json. Returns an empty registry if the file is missing. */
function readClustersFileSync(storageDir: string): unknown {
  const clustersFile = clustersFilePath(storageDir);
  if (!fs.existsSync(clustersFile)) {
    return {};
  }
  const raw = fs.readFileSync(clustersFile, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return parsed;
}

/** Write clusters.json atomically through a process-scoped temporary file. */
function writeClustersFileAtomic(storageDir: string, data: unknown): void {
  const clustersFile = clustersFilePath(storageDir);
  const tmpPath = `${clustersFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, clustersFile);
}

export = { clustersFilePath, readClustersFileSync, writeClustersFileAtomic };
