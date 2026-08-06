const { test } = require('node:test');
const {
  assert,
  DEFAULT_OMP_RPC_DECODER_LIMITS,
  FIXTURES_DIR,
  HAPPY_PATH_SCENARIOS,
  OMP_INSTALL_COMMAND,
  OMP_PACKAGE_NAME,
  OMP_RELEASE_ASSETS,
  OMP_SUPPORTED_VERSION,
  decodeSplit,
  decodeWhole,
  findOmpReleaseAsset,
  fs,
  ompReleaseAssetDownloadUrl,
  path,
  readFixture,
} = require('../helpers/omp-rpc-protocol-harness');

// (a) omp-release exports: version-selected package install (not asset-digest attestation)
// alongside the preserved release-asset digest table #868/#869/#901 consume for their own
// download-verification paths.
test('omp-release exports OMP_SUPPORTED_VERSION 17.2.1', () => {
  assert.equal(OMP_SUPPORTED_VERSION, '17.2.1');
});

test('omp-release exports the bun install command for the pinned package/version', () => {
  assert.equal(OMP_PACKAGE_NAME, '@oh-my-pi/pi-coding-agent');
  assert.equal(OMP_INSTALL_COMMAND, 'bun install -g @oh-my-pi/pi-coding-agent@17.2.1');
});

test('omp-release exports exactly 6 Unix assets with the verified digests', () => {
  assert.equal(OMP_RELEASE_ASSETS.length, 6);
  const byPlatform = new Map(OMP_RELEASE_ASSETS.map((asset) => [asset.platform, asset]));
  assert.deepEqual(
    Object.fromEntries(
      [...byPlatform.entries()].map(([platform, asset]) => [platform, asset.sha256])
    ),
    {
      'darwin-arm64': 'b75eddb19ba9ec401fee5ecb35b3ceb5ddc48708e98b5a113136df5d65f2bed8',
      'darwin-x64': 'd23c197d93243122ef9a35a247bdd85075c4c1356dd1fa4a080faaa2dae4b905',
      'linux-arm64': 'd34883744bb54476f7268aad4b561ea9b1cd826f201d044b337c5a96713fa83d',
      'linux-musl-arm64': '3babfe15664f32fcc03dc91d92a10341baf6e65b9868351de21c5aa3218e139d',
      'linux-musl-x64': '8f05f7eed2940b11c29d7aaf0e641b100c014db5bfbee00afa5dd4929ad5dd6a',
      'linux-x64': 'ac0285a571aa79c58d59482561a3871befe7333dba3a3bdc2e90682653ee33b2',
    }
  );
  for (const asset of OMP_RELEASE_ASSETS) {
    assert.equal(asset.sha256.length, 64);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }
});

test('findOmpReleaseAsset / ompReleaseAssetDownloadUrl resolve by platform', () => {
  const asset = findOmpReleaseAsset('linux-x64');
  assert.ok(asset);
  assert.equal(asset.name, 'omp-linux-x64');
  assert.equal(
    ompReleaseAssetDownloadUrl(asset),
    'https://github.com/can1357/oh-my-pi/releases/download/v17.2.1/omp-linux-x64'
  );
  assert.equal(findOmpReleaseAsset('windows-x64'), undefined);
});

// (b) decoder happy path per fixture scenario, fed whole-buffer and split at 1-byte/3-byte
// granularities, asserting identical output every time.
for (const scenario of HAPPY_PATH_SCENARIOS) {
  test(`OmpRpcFrameDecoder decodes ${scenario}.jsonl identically at every read granularity`, () => {
    const buffer = readFixture(scenario);
    const whole = decodeWhole(DEFAULT_OMP_RPC_DECODER_LIMITS, buffer);
    const split1 = decodeSplit(DEFAULT_OMP_RPC_DECODER_LIMITS, buffer, 1);
    const split3 = decodeSplit(DEFAULT_OMP_RPC_DECODER_LIMITS, buffer, 3);
    assert.ok(whole.length > 0);
    assert.deepStrictEqual(split1, whole);
    assert.deepStrictEqual(split3, whole);
  });
}

test('same-id-late-failure.jsonl: decoder does not reject a second same-id response', () => {
  const frames = decodeWhole(DEFAULT_OMP_RPC_DECODER_LIMITS, readFixture('same-id-late-failure'));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].id, 'req_2');
  assert.equal(frames[1].id, 'req_2');
  assert.equal(frames[0].success, true);
  assert.equal(frames[1].success, false);
});

test('chunked-response.jsonl reassembles into one response frame with the expected shape', () => {
  const frames = decodeWhole(DEFAULT_OMP_RPC_DECODER_LIMITS, readFixture('chunked-response'));
  assert.equal(frames.length, 1);
  const [frame] = frames;
  assert.equal(frame.type, 'response');
  assert.equal(frame.command, 'get_messages_page');
  assert.equal(frame.success, true);
  assert.equal(frame.data.totalMessages, 40);
  assert.equal(frame.data.messages.length, 40);
});

test('lifecycle-continuation.jsonl preserves willContinue across turns', () => {
  const frames = decodeWhole(DEFAULT_OMP_RPC_DECODER_LIMITS, readFixture('lifecycle-continuation'));
  const agentEnds = frames.filter((frame) => frame.type === 'agent_end');
  assert.equal(agentEnds.length, 2);
  assert.equal(agentEnds[0].willContinue, true);
  assert.equal(agentEnds[1].willContinue, undefined);
});

test('compacted-agent-end.jsonl carries messageCount without re-streaming the message', () => {
  const frames = decodeWhole(DEFAULT_OMP_RPC_DECODER_LIMITS, readFixture('compacted-agent-end'));
  const agentEnd = frames.find((frame) => frame.type === 'agent_end');
  assert.ok(agentEnd);
  assert.deepEqual(agentEnd.messages, []);
  assert.equal(agentEnd.messageCount, 1);
});

test('stderr-emission fixtures: the stderr file is plain text the codec never parses', () => {
  const stderrText = fs.readFileSync(path.join(FIXTURES_DIR, 'stderr-emission.stderr.txt'), 'utf8');
  assert.throws(() => JSON.parse(stderrText.split('\n')[0]));
  const stdoutFrames = decodeWhole(
    DEFAULT_OMP_RPC_DECODER_LIMITS,
    readFixture('stderr-emission.stdout')
  );
  assert.ok(stdoutFrames.every((frame) => typeof frame.type === 'string'));
});
