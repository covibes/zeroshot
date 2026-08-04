'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_RELATIVE_PATH_BYTES = 1024;
const WORKSPACE = '/workspace';
const FORBIDDEN_NAMES = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.config',
  '.claude',
  '.codex',
  '.omp',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  'credentials.json',
]);
const TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List regular files beneath the prepared workspace.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read one bounded UTF-8 source file from the prepared workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Atomically replace or create one bounded UTF-8 source file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
]);

function forbiddenName(name) {
  return (
    FORBIDDEN_NAMES.has(name) || name.startsWith('.env') || name.startsWith('.zeroshot-write-')
  );
}

function workspacePath(relative) {
  if (
    typeof relative !== 'string' ||
    relative.length === 0 ||
    Buffer.byteLength(relative) > MAX_RELATIVE_PATH_BYTES ||
    relative.includes('\0') ||
    relative.includes('\\') ||
    path.posix.isAbsolute(relative)
  ) {
    throw new Error('Tool path is invalid');
  }
  const segments = relative.split('/');
  if (
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || forbiddenName(segment)
    )
  ) {
    throw new Error('Tool path is invalid');
  }
  const absolute = path.resolve(WORKSPACE, ...segments);
  if (!absolute.startsWith(`${WORKSPACE}${path.sep}`))
    throw new Error('Tool path escaped workspace');
  return { absolute, relative: segments.join('/') };
}

function assertDirectoryChain(absolute, includeLeaf) {
  const relative = path.relative(WORKSPACE, includeLeaf ? absolute : path.dirname(absolute));
  let current = WORKSPACE;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = fs.lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Tool path crosses an unsafe directory');
    }
  }
}

function readRegularFile(relative) {
  const target = workspacePath(relative);
  assertDirectoryChain(target.absolute, false);
  const before = fs.lstatSync(target.absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) {
    throw new Error('Tool target is not a bounded regular file');
  }
  const descriptor = fs.openSync(
    target.absolute,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const pinned = fs.fstatSync(descriptor);
    if (
      !pinned.isFile() ||
      pinned.dev !== before.dev ||
      pinned.ino !== before.ino ||
      pinned.size > MAX_FILE_BYTES
    ) {
      throw new Error('Tool target changed during validation');
    }
    const bytes = Buffer.alloc(pinned.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('Tool target was truncated during read');
      offset += count;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    fs.closeSync(descriptor);
  }
}

function collectWorkspaceEntry(directory, entry, files, pending) {
  if (forbiddenName(entry.name) || entry.isSymbolicLink()) {
    throw new Error('Workspace contains an unsafe entry');
  }
  const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
  workspacePath(relative);
  if (entry.isDirectory()) {
    pending.push({ absolute: path.join(directory.absolute, entry.name), relative });
  } else if (entry.isFile()) {
    files.push(relative);
  } else {
    throw new Error('Workspace contains a non-file entry');
  }
  if (files.length + pending.length > MAX_FILES) {
    throw new Error('Workspace file count exceeded its bound');
  }
}

function listRegularFiles() {
  const files = [];
  const pending = [{ absolute: WORKSPACE, relative: '' }];
  while (pending.length > 0) {
    const directory = pending.pop();
    assertDirectoryChain(directory.absolute, true);
    const entries = fs
      .readdirSync(directory.absolute, { withFileTypes: true })
      .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const entry of entries) collectWorkspaceEntry(directory, entry, files, pending);
  }
  return files.sort();
}

function existingMetadata(absolute) {
  try {
    return fs.lstatSync(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function temporaryPath(target) {
  return path.join(
    path.dirname(target.absolute),
    `.zeroshot-write-${process.pid}-${crypto.randomUUID()}`
  );
}

function writeTemporaryFile(temporary, content, mode) {
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    mode
  );
  try {
    const bytes = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncParentDirectory(absolute) {
  const parent = fs.openSync(
    path.dirname(absolute),
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  );
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}

function replaceWithTemporary(temporary, absolute) {
  try {
    fs.renameSync(temporary, absolute);
    syncParentDirectory(absolute);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The rename succeeded or another cleanup owner already removed the temporary file.
    }
    throw error;
  }
}

function writeRegularFile(relative, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES) {
    throw new Error('Tool content exceeded its bound');
  }
  const target = workspacePath(relative);
  assertDirectoryChain(target.absolute, false);
  const existing = existingMetadata(target.absolute);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('Tool target is not a regular file');
  }
  if (existing && readRegularFile(relative) === content) return false;
  const temporary = temporaryPath(target);
  writeTemporaryFile(temporary, content, existing ? existing.mode & 0o777 : 0o644);
  replaceWithTemporary(temporary, target.absolute);
  return true;
}

function parseToolArguments(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_FILE_BYTES * 2) {
    throw new Error('Tool arguments exceeded their bound');
  }
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments are invalid');
  }
  return parsed;
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

const TOOL_EXECUTORS = new Map([
  [
    'list_files',
    (args) => {
      if (!hasExactKeys(args, [])) throw new Error('Unsupported list_files arguments');
      return { content: JSON.stringify({ files: listRegularFiles() }), changed: false };
    },
  ],
  [
    'read_file',
    (args) => {
      if (!hasExactKeys(args, ['path'])) throw new Error('Unsupported read_file arguments');
      return { content: readRegularFile(args.path), changed: false };
    },
  ],
  [
    'write_file',
    (args) => {
      if (!hasExactKeys(args, ['path', 'content'])) {
        throw new Error('Unsupported write_file arguments');
      }
      const changed = writeRegularFile(args.path, args.content);
      return { content: JSON.stringify({ written: changed }), changed };
    },
  ],
]);

function executeTool(call) {
  if (!call || call.type !== 'function' || typeof call.id !== 'string' || !call.function) {
    throw new Error('Fixed proxy returned a malformed tool call');
  }
  const execute = TOOL_EXECUTORS.get(call.function.name);
  if (!execute) throw new Error('Fixed proxy requested an unsupported tool operation');
  return execute(parseToolArguments(call.function.arguments));
}

module.exports = { executeTool, TOOLS, WORKSPACE };
