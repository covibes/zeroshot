'use strict';

const { strict: assert } = require('node:assert');
const { readFileSync, createReadStream, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const {
  ClusterRequestError,
  assertDistinctRequestSources,
  assertGraphProfile,
  assertGraphProfileSupported,
  assertGraphSpec,
  assertInputValue,
  decodeBoundedJson,
  firstInputValidationIssue,
  MAX_REQUEST_BYTES,
  readBoundedSource,
} = require('../../lib/cluster/index.cjs');
const { filesBelow } = require('./harness');

const root = resolve(__dirname, '../..');
const protocolRoot = join(root, 'protocol/openengine-cluster/v1');
const graphFixturesRoot = join(protocolRoot, 'fixtures/graph');

function isRequestError(code) {
  return (error) => error instanceof ClusterRequestError && error.code === code;
}

function isJsonPointerLike(path) {
  if (path === '') return true;
  if (!path.startsWith('/')) return false;
  return path.split('/').slice(1).every((segment) => segment.length > 0);
}

test('assertGraphSpec accepts positive GraphSpec fixtures and rejects every graph-schema negative fixture', () => {
  for (const name of ['single-worker.json', 'full-all-nodes.json']) {
    const document = JSON.parse(readFileSync(join(graphFixturesRoot, 'positive', name), 'utf8'));
    assert.doesNotThrow(() => assertGraphSpec(document), name);
  }
  let checked = 0;
  for (const file of filesBelow(join(graphFixturesRoot, 'negative'))) {
    const fixture = JSON.parse(readFileSync(file, 'utf8'));
    if (fixture.schema !== 'graph') continue;
    checked += 1;
    assert.throws(() => assertGraphSpec(fixture.document), isRequestError('INVALID_GRAPH'), file);
  }
  assert.equal(checked, 20);
});

test('assertGraphProfile accepts real profile literals and rejects unknown ones', () => {
  assert.doesNotThrow(() => assertGraphProfile('openengine.graph.single-worker/v1'));
  assert.doesNotThrow(() => assertGraphProfile('openengine.graph.full/v1'));
  assert.throws(
    () => assertGraphProfile('openengine.graph.unknown/v1'),
    isRequestError('INVALID_GRAPH_PROFILE')
  );
});

test('assertGraphProfileSupported enforces server-advertised graphProfiles', () => {
  const profile = 'openengine.graph.single-worker/v1';
  assert.doesNotThrow(() =>
    assertGraphProfileSupported(profile, { graphProfiles: [profile, 'openengine.graph.full/v1'] })
  );
  assert.throws(
    () => assertGraphProfileSupported(profile, { graphProfiles: ['openengine.graph.full/v1'] }),
    isRequestError('UNSUPPORTED_GRAPH_PROFILE')
  );
  assert.throws(
    () => assertGraphProfileSupported(profile, {}),
    isRequestError('UNSUPPORTED_GRAPH_PROFILE')
  );
});

test('firstInputValidationIssue / assertInputValue mirror admission.rs:70-90', () => {
  const payload = {
    kind: 'record',
    fields: {
      count: { required: true, type: { kind: 'integer' } },
      label: { required: false, type: { kind: 'string' } },
    },
  };
  assert.equal(firstInputValidationIssue(payload, { count: 2, label: 'ok' }), null);
  assert.equal(firstInputValidationIssue(payload, JSON.parse('{"count":2.0}')), null);
  assert.deepEqual(firstInputValidationIssue(payload, { label: 'missing' }), {
    path: '/count',
    code: 'MISSING_REQUIRED_FIELD',
  });
  assert.deepEqual(firstInputValidationIssue(payload, { count: 1, extra: true }), {
    path: '/extra',
    code: 'UNKNOWN_FIELD',
  });
  assert.deepEqual(firstInputValidationIssue(payload, { count: 1.5 }), {
    path: '/count',
    code: 'TYPE_MISMATCH',
  });
  assert.equal(firstInputValidationIssue({ kind: 'number' }, 1.5), null);

  assert.doesNotThrow(() => assertInputValue(payload, { count: 2, label: 'ok' }));
  assert.throws(() => assertInputValue(payload, { label: 'missing' }), isRequestError('INVALID_INPUT'));
});

test('firstInputValidationIssue covers every PayloadType kind with JSON-pointer-style paths', () => {
  assert.equal(firstInputValidationIssue({ kind: 'null' }, null), null);
  assert.deepEqual(firstInputValidationIssue({ kind: 'null' }, 0), { path: '', code: 'TYPE_MISMATCH' });

  assert.equal(firstInputValidationIssue({ kind: 'boolean' }, true), null);
  assert.deepEqual(firstInputValidationIssue({ kind: 'boolean' }, 'true'), {
    path: '',
    code: 'TYPE_MISMATCH',
  });

  assert.equal(firstInputValidationIssue({ kind: 'number' }, 1.5), null);
  assert.deepEqual(firstInputValidationIssue({ kind: 'number' }, 'x'), { path: '', code: 'TYPE_MISMATCH' });

  assert.equal(firstInputValidationIssue({ kind: 'string' }, 'ok'), null);
  assert.deepEqual(firstInputValidationIssue({ kind: 'string' }, 1), { path: '', code: 'TYPE_MISMATCH' });

  const enumType = { kind: 'enum', values: ['accepted', 'rejected'] };
  assert.equal(firstInputValidationIssue(enumType, 'accepted'), null);
  const enumIssue = firstInputValidationIssue(enumType, 'unknown');
  assert.deepEqual(enumIssue, { path: '', code: 'UNKNOWN_ENUM_LABEL' });

  const arrayType = { kind: 'array', items: { kind: 'string' } };
  assert.equal(firstInputValidationIssue(arrayType, ['a', 'b']), null);
  const arrayIssue = firstInputValidationIssue(arrayType, ['a', 1]);
  assert.deepEqual(arrayIssue, { path: '/1', code: 'TYPE_MISMATCH' });

  for (const issue of [enumIssue, arrayIssue]) assert.ok(isJsonPointerLike(issue.path), issue.path);
});

test('assertInputValue never leaks the offending value into its error message', () => {
  const marker = 'SECRET_MARKER_9f3a';
  assert.throws(
    () => assertInputValue({ kind: 'string' }, { leaked: marker }),
    (error) => error instanceof ClusterRequestError && !error.message.includes(marker)
  );
  const enumType = { kind: 'enum', values: ['known'] };
  assert.throws(
    () => assertInputValue(enumType, marker),
    (error) => error instanceof ClusterRequestError && !error.message.includes(marker)
  );
  const nested = { kind: 'record', fields: { secret: { required: true, type: { kind: 'string' } } } };
  assert.throws(
    () => assertInputValue(nested, { secret: 12345 }),
    (error) => error instanceof ClusterRequestError && !error.message.includes('12345')
  );
});

test('decodeBoundedJson enforces the byte, UTF-8, and JSON syntax bounds', () => {
  assert.throws(
    () => decodeBoundedJson(new Uint8Array(MAX_REQUEST_BYTES + 1)),
    isRequestError('OVERSIZED_JSON')
  );
  assert.throws(
    () => decodeBoundedJson(new Uint8Array([0x80])),
    isRequestError('INVALID_UTF8')
  );
  assert.throws(
    () => decodeBoundedJson(Buffer.from('{not json')),
    isRequestError('MALFORMED_JSON')
  );
  assert.deepEqual(decodeBoundedJson(Buffer.from('{"a":1,"a":2}')), { a: 2 });
  assert.equal(decodeBoundedJson(Buffer.from('null')), null);
});

test('readBoundedSource reads a stream to completion and enforces the byte bound incrementally', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cluster-request-validation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const smallFile = join(dir, 'input.json');
  writeFileSync(smallFile, '{"count":1}');
  const bytes = await readBoundedSource(createReadStream(smallFile));
  assert.equal(Buffer.from(bytes).toString('utf8'), '{"count":1}');

  const stdinBytes = await readBoundedSource(Readable.from([Buffer.from('null')]));
  assert.equal(Buffer.from(stdinBytes).toString('utf8'), 'null');

  const oversizedFile = join(dir, 'oversized.json');
  writeFileSync(oversizedFile, Buffer.alloc(MAX_REQUEST_BYTES + 1, 0x20));
  await assert.rejects(
    () => readBoundedSource(createReadStream(oversizedFile)),
    isRequestError('OVERSIZED_JSON')
  );

  // Never fully buffers an oversized source: a stream whose later chunks would hang
  // forever if pulled must still reject as soon as the accumulated total crosses the
  // bound, using only the chunks already seen.
  async function* growingChunks() {
    yield Buffer.alloc(MAX_REQUEST_BYTES, 0x20);
    yield Buffer.alloc(MAX_REQUEST_BYTES, 0x20);
    throw new Error('readBoundedSource must not pull past the byte bound');
  }
  await assert.rejects(
    () => readBoundedSource(Readable.from(growingChunks())),
    isRequestError('OVERSIZED_JSON')
  );
});

test('assertDistinctRequestSources requires an explicit input source and forbids double stdin', () => {
  assert.throws(
    () => assertDistinctRequestSources('graph.json', undefined),
    isRequestError('MISSING_INPUT')
  );
  assert.throws(
    () => assertDistinctRequestSources('-', '-'),
    isRequestError('AMBIGUOUS_STDIN_SOURCE')
  );
  assert.doesNotThrow(() => assertDistinctRequestSources('-', 'input.json'));
  assert.doesNotThrow(() => assertDistinctRequestSources('graph.json', 'input.json'));
  // A source string pointing at a file whose decoded content is JSON null is a valid,
  // fully-provided input — assertDistinctRequestSources only rejects an *omitted* flag.
  assert.doesNotThrow(() => assertDistinctRequestSources('graph.json', 'null-input.json'));
});
