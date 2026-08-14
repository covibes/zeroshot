import { createReplacingDestination, type ExportStream } from './export-stream';

interface LedgerMessageIterator extends Iterator<unknown> {
  return?: () => IteratorResult<unknown>;
}

interface ClusterLedger {
  iterateAll(clusterId: string): LedgerMessageIterator;
}

interface JsonExportOptions {
  ledger: ClusterLedger;
  clusterId: string;
  outputPath?: string | null;
  stdout?: ExportStream;
}

function indentJson(value: unknown, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function streamClusterJsonExport({
  ledger,
  clusterId,
  outputPath = null,
  stdout = process.stdout,
}: JsonExportOptions): void {
  const destination = createReplacingDestination(outputPath, stdout);
  const iterator = ledger.iterateAll(clusterId);
  try {
    destination.write(`{\n  "cluster_id": ${JSON.stringify(clusterId)},\n  "messages": `);
    let current = iterator.next();
    if (current.done) {
      destination.write('[]\n}\n');
      return;
    }

    destination.write('[\n');
    while (!current.done) {
      destination.write(indentJson(current.value, 4));
      current = iterator.next();
      destination.write(current.done ? '\n' : ',\n');
    }
    destination.write('  ]\n}\n');
  } finally {
    try {
      if (typeof iterator.return === 'function') iterator.return();
    } finally {
      destination.close();
    }
  }
}

export = { streamClusterJsonExport };
