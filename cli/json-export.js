const fs = require('fs');

function indentJson(value, spaces) {
  const prefix = ' '.repeat(spaces);
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function writeAll(fd, value) {
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

function createDestination(outputPath, stdout) {
  if (outputPath) {
    const fd = fs.openSync(outputPath, 'w');
    return {
      close: () => fs.closeSync(fd),
      write: (value) => writeAll(fd, value),
    };
  }

  if (Number.isInteger(stdout.fd)) {
    return {
      close() {},
      write: (value) => writeAll(stdout.fd, value),
    };
  }

  return {
    close() {},
    write: (value) => stdout.write(value),
  };
}

function streamClusterJsonExport({
  ledger,
  clusterId,
  outputPath = null,
  stdout = process.stdout,
}) {
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

module.exports = { streamClusterJsonExport };
