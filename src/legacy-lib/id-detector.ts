/**
 * ID Detector - Determines if an ID is a task or cluster
 *
 * Strategy:
 * 1. Check if ID exists in cluster storage
 * 2. If not, check if ID exists in task storage (SQLite)
 * 3. Return type: 'cluster', 'task', or null
 */

import path = require('path');
import fs = require('fs');
import os = require('os');
import Database = require('better-sqlite3');
import clustersRegistry = require('./clusters-registry');

type IdType = 'cluster' | 'task' | null;

function hasClusterId(clusters: unknown, id: string): boolean {
  return Boolean(Reflect.get(Object(clusters), id));
}

/** Detect if an ID belongs to a cluster or task. */
function detectIdType(id: string): IdType {
  const homeDir =
    process.env.ZEROSHOT_HOME ||
    process.env.HOME ||
    process.env.USERPROFILE ||
    os.homedir();
  const storageDir = path.join(homeDir, '.zeroshot');
  const taskDbFile = path.join(homeDir, '.claude-zeroshot', 'store.db');

  try {
    const clusters = clustersRegistry.readClustersFileSync(storageDir);
    if (hasClusterId(clusters, id)) {
      return 'cluster';
    }
  } catch {
    // Ignore parse errors
  }

  if (fs.existsSync(taskDbFile)) {
    try {
      const db = new Database(taskDbFile, { readonly: true, timeout: 5000 });
      const row: unknown = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
      db.close();
      if (row) {
        return 'task';
      }
    } catch {
      // Ignore DB errors
    }
  }

  return null;
}

export = { detectIdType };
