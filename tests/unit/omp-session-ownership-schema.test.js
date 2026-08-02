/**
 * task-lib/omp-session-ownership-schema.js — the *closed* `task.ompSessionOwnership` schema from
 * issue #866, validated and canonicalized on every read and write.
 *
 * "Closed" is load-bearing here, not stylistic: this record decides which directory a cleanup
 * surface deletes and which session a resume continues, so anything it fails to pin down is
 * something a stale, tampered, or cross-version row could smuggle past. Every case below is an
 * input the validator must reject outright rather than partially trust.
 */

const assert = require('assert');
const path = require('path');
const { randomUUID } = require('crypto');

let schema;
before(async function () {
  schema = await import('../../task-lib/omp-session-ownership-schema.js');
});

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

function baseRecord(overrides = {}) {
  const partitionId = overrides.partitionId ?? randomUUID();
  const storageRoot = overrides.storageRoot ?? '/srv/zeroshot';
  return {
    schemaVersion: 1,
    state: 'provisional',
    partitionId,
    storageRoot,
    partitionPath: path.join(storageRoot, 'omp-sessions', partitionId),
    ownerUid: '1000',
    storageRootIdentity: { device: '2049', inode: '11' },
    partitionIdentity: null,
    canonicalWorkspace: '/work',
    owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: 'task-1' },
    session: null,
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    sessionId: 'sess-1',
    fileName: '2026-08-02T00-00-00-000Z_sess-1.jsonl',
    fileIdentity: { device: '2049', inode: '12' },
    artifactManifestDigest: DIGEST_A,
    executionFingerprint: DIGEST_B,
    selectedProvider: 'anthropic',
    selectedModel: '@default',
    ...overrides,
  };
}

function committedRecord(overrides = {}) {
  return baseRecord({
    state: 'committed',
    partitionIdentity: { device: '2049', inode: '13' },
    session: session(),
    ...overrides,
  });
}

describe('task-lib/omp-session-ownership-schema.js (closed ownership schema)', function () {
  it('accepts and canonicalizes a well-formed provisional and committed record', function () {
    const provisional = schema.validateOmpSessionOwnership(baseRecord());
    assert.ok(provisional);
    assert.strictEqual(provisional.state, 'provisional');
    assert.strictEqual(provisional.partitionIdentity, null);
    assert.strictEqual(provisional.session, null);

    const committed = schema.validateOmpSessionOwnership(committedRecord());
    assert.ok(committed);
    assert.strictEqual(committed.session.sessionId, 'sess-1');
    assert.deepStrictEqual(
      Object.keys(committed),
      [
        'schemaVersion',
        'state',
        'partitionId',
        'storageRoot',
        'partitionPath',
        'ownerUid',
        'storageRootIdentity',
        'partitionIdentity',
        'canonicalWorkspace',
        'owner',
        'session',
      ],
      'canonicalization must emit a fixed key order so full-value CAS is byte-stable'
    );
  });

  it('rejects unknown keys at every level', function () {
    assert.strictEqual(schema.validateOmpSessionOwnership(baseRecord({ extra: 1 })), null);
    assert.strictEqual(
      schema.validateOmpSessionOwnership(
        baseRecord({
          owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: 't', extra: 1 },
        })
      ),
      null
    );
    assert.strictEqual(
      schema.validateOmpSessionOwnership(committedRecord({ session: session({ extra: 1 }) })),
      null
    );
    assert.strictEqual(
      schema.validateOmpSessionOwnership(
        committedRecord({ storageRootIdentity: { device: '1', inode: '2', extra: 3 } })
      ),
      null
    );
  });

  it('requires a real UUID partition id', function () {
    for (const partitionId of ['', 'not-a-uuid', '../escape', '11111111-1111-1111-1111-11111111', 42]) {
      const record = baseRecord();
      record.partitionId = partitionId;
      assert.strictEqual(
        schema.validateOmpSessionOwnership(record),
        null,
        `partitionId ${JSON.stringify(partitionId)} must be rejected`
      );
    }
  });

  it('requires canonical absolute paths', function () {
    for (const key of ['storageRoot', 'partitionPath', 'canonicalWorkspace']) {
      for (const value of ['relative/path', '/srv/../srv', '/srv/zeroshot/', '', null]) {
        assert.strictEqual(
          schema.validateOmpSessionOwnership(baseRecord({ [key]: value })),
          null,
          `${key}=${JSON.stringify(value)} must be rejected`
        );
      }
    }
  });

  it('re-derives partitionPath from storageRoot + partitionId instead of trusting it', function () {
    const record = baseRecord();
    record.partitionPath = '/srv/zeroshot/omp-sessions/../../elsewhere';
    assert.strictEqual(schema.validateOmpSessionOwnership(record), null);

    const relocated = baseRecord();
    relocated.partitionPath = path.join('/srv/zeroshot', 'omp-sessions', randomUUID());
    assert.strictEqual(
      schema.validateOmpSessionOwnership(relocated),
      null,
      'a partitionPath naming a different partition id is not this record s partition'
    );
  });

  it('requires a direct-child *.jsonl session file name', function () {
    for (const fileName of ['sub/dir.jsonl', '../escape.jsonl', 'session.txt', '.jsonl', '', 7]) {
      assert.strictEqual(
        schema.validateOmpSessionOwnership(committedRecord({ session: session({ fileName }) })),
        null,
        `fileName ${JSON.stringify(fileName)} must be rejected`
      );
    }
  });

  it('rejects partially populated identity/session pairs in every state', function () {
    for (const state of ['provisional', 'committed', 'cleanup-required']) {
      assert.strictEqual(
        schema.validateOmpSessionOwnership(
          baseRecord({ state, partitionIdentity: { device: '1', inode: '2' }, session: null })
        ),
        null,
        `${state}: identity without session`
      );
      assert.strictEqual(
        schema.validateOmpSessionOwnership(
          baseRecord({ state, partitionIdentity: null, session: session() })
        ),
        null,
        `${state}: session without identity`
      );
    }
  });

  it('allows a fully observed cleanup-required record and requires the observation when committed', function () {
    assert.ok(
      schema.validateOmpSessionOwnership(
        baseRecord({
          state: 'cleanup-required',
          partitionIdentity: { device: '1', inode: '2' },
          session: session(),
        })
      )
    );
    assert.ok(
      schema.validateOmpSessionOwnership(baseRecord({ state: 'cleanup-required' })),
      'an uncertain record that never observed a session is still valid'
    );
    assert.strictEqual(
      schema.validateOmpSessionOwnership(baseRecord({ state: 'committed' })),
      null,
      'committed asserts a resumable session, so the observation is mandatory'
    );
  });

  it('enforces the owner kind invariants', function () {
    assert.strictEqual(
      schema.validateOmpSessionOwnership(
        baseRecord({ owner: { kind: 'cluster-agent', clusterId: null, agentId: null, taskId: 't' } })
      ),
      null,
      'cluster-agent requires both ids'
    );
    assert.strictEqual(
      schema.validateOmpSessionOwnership(
        baseRecord({ owner: { kind: 'standalone', clusterId: 'c', agentId: 'a', taskId: 't' } })
      ),
      null,
      'standalone requires both ids to be null'
    );
    assert.strictEqual(
      schema.validateOmpSessionOwnership(
        baseRecord({ owner: { kind: 'other', clusterId: null, agentId: null, taskId: 't' } })
      ),
      null
    );
    assert.ok(
      schema.validateOmpSessionOwnership(
        baseRecord({ owner: { kind: 'cluster-agent', clusterId: 'c', agentId: 'a', taskId: 't' } })
      )
    );
  });

  it('requires canonical decimal uid/device/inode strings and sha256:<64-lower-hex> digests', function () {
    for (const ownerUid of ['-1', '01', '1.0', 1000, '']) {
      assert.strictEqual(schema.validateOmpSessionOwnership(baseRecord({ ownerUid })), null);
    }
    for (const identity of [{ device: '01', inode: '1' }, { device: 1, inode: 2 }, { device: '1' }]) {
      assert.strictEqual(
        schema.validateOmpSessionOwnership(baseRecord({ storageRootIdentity: identity })),
        null
      );
    }
    for (const digest of ['sha256:' + 'A'.repeat(64), 'sha1:' + 'a'.repeat(40), 'a'.repeat(64), '']) {
      assert.strictEqual(
        schema.validateOmpSessionOwnership(
          committedRecord({ session: session({ artifactManifestDigest: digest }) })
        ),
        null
      );
      assert.strictEqual(
        schema.validateOmpSessionOwnership(
          committedRecord({ session: session({ executionFingerprint: digest }) })
        ),
        null
      );
    }
  });

  it('rejects wrong schema versions, unknown states, arrays, and non-objects', function () {
    assert.strictEqual(schema.validateOmpSessionOwnership(baseRecord({ schemaVersion: 2 })), null);
    assert.strictEqual(schema.validateOmpSessionOwnership(baseRecord({ state: 'done' })), null);
    for (const value of [null, undefined, 'x', 5, [], [baseRecord()]]) {
      assert.strictEqual(schema.validateOmpSessionOwnership(value), null);
    }
  });

  it('validateOwnedByTask fences a record to the row it was read from', function () {
    const record = committedRecord();
    assert.ok(schema.validateOwnedByTask(record, 'task-1'));
    assert.strictEqual(
      schema.validateOwnedByTask(record, 'task-2'),
      null,
      'a well-formed record naming another owner is not this row s ownership'
    );
    assert.strictEqual(schema.validateOwnedByTask(record, ''), null);
    assert.strictEqual(schema.validateOwnedByTask(record, undefined), null);
    assert.strictEqual(schema.validateOwnedByTask(null, 'task-1'), null);
  });

  it('parse/serialize round-trip is byte-stable, and refuses to persist an invalid record', function () {
    const record = committedRecord();
    const serialized = schema.serializeOmpSessionOwnership(record);
    const parsed = schema.parseOmpSessionOwnership(serialized);
    assert.deepStrictEqual(parsed, schema.validateOmpSessionOwnership(record));
    assert.strictEqual(
      schema.serializeOmpSessionOwnership(parsed),
      serialized,
      'a re-serialized parse must be identical, or full-value CAS silently stops matching'
    );

    // Key order in the input must not change the output, for the same reason.
    const shuffled = Object.fromEntries(Object.entries(record).reverse());
    assert.strictEqual(schema.serializeOmpSessionOwnership(shuffled), serialized);

    assert.strictEqual(schema.serializeOmpSessionOwnership(null), null);
    assert.throws(
      () => schema.serializeOmpSessionOwnership(baseRecord({ partitionId: 'nope' })),
      /Refusing to persist an invalid ompSessionOwnership record/
    );
    assert.strictEqual(schema.parseOmpSessionOwnership('{not json'), null);
    assert.strictEqual(schema.parseOmpSessionOwnership(''), null);
    assert.strictEqual(schema.parseOmpSessionOwnership(null), null);
  });

  it('buildProvisionalOwnership derives the partition path and rejects a bad partition id', function () {
    const partitionId = randomUUID();
    const record = schema.buildProvisionalOwnership({
      partitionId,
      storageRoot: '/srv/zeroshot/',
      storageRootIdentity: { device: '1', inode: '2' },
      canonicalWorkspace: '/work/./space',
      owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: 't' },
    });
    assert.strictEqual(record.storageRoot, '/srv/zeroshot');
    assert.strictEqual(record.canonicalWorkspace, '/work/space');
    assert.strictEqual(
      record.partitionPath,
      path.join('/srv/zeroshot', 'omp-sessions', partitionId)
    );
    assert.throws(() =>
      schema.buildProvisionalOwnership({
        partitionId: 'not-a-uuid',
        storageRoot: '/srv',
        storageRootIdentity: { device: '1', inode: '2' },
        canonicalWorkspace: '/work',
        owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: 't' },
      })
    );
  });

  it('computeExecutionFingerprint is stable under key order and sensitive to any value', function () {
    const a = schema.computeExecutionFingerprint({ x: '1', y: '2' });
    const b = schema.computeExecutionFingerprint({ y: '2', x: '1' });
    assert.strictEqual(a, b);
    assert.match(a, /^sha256:[a-f0-9]{64}$/);
    assert.notStrictEqual(a, schema.computeExecutionFingerprint({ x: '1', y: '3' }));
  });
});
