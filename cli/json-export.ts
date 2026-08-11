import fs = require('fs');

interface LedgerMessageIterator extends Iterator<unknown> {
  return?: () => IteratorResult<unknown>;
}

interface ClusterLedger {
  iterateAll(clusterId: string): LedgerMessageIterator;
}

interface ExportStream {
  readonly fd?: number;
  write(value: string): unknown;
}

interface JsonExportOptions {
  ledger: ClusterLedger;
  clusterId: string;
  outputPath?: string | null;
  stdout?: ExportStream;
}

interface Destination {
  close(): void;
  write(value: string): void;
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function indentJson(value: unknown, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function writeAll(fd: number, value: string): void {
  const bytes = Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error('JSON export destination stopped accepting bytes');
    }
    offset += written;
  }
}

function createDestination(
  outputPath: string | null | undefined,
  stdout: ExportStream
): Destination {
  if (outputPath) {
    const fd = fs.openSync(outputPath, 'w');
    return {
      close: () => fs.closeSync(fd),
      write: (value) => writeAll(fd, value),
    };
  }

  if (isInteger(stdout.fd)) {
    const fd = stdout.fd;
    return {
      close(): void {},
      write: (value) => writeAll(fd, value),
    };
  }

  return {
    close(): void {},
    write: (value): void => {
      stdout.write(value);
    },
  };
}

function streamClusterJsonExport({
  ledger,
  clusterId,
  outputPath = null,
  stdout = process.stdout,
}: JsonExportOptions): void {
  const destination = createDestination(outputPath, stdout);
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
