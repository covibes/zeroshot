const assert = require('assert');
const crypto = require('crypto');
const IsolationManager = require('../../src/isolation-manager');
const { getProviderMetadata } = require('../../lib/provider-names');
const {
  OMP_DOCKER_INSTALL_COMMAND,
  OMP_DOCKER_PLATFORM,
  OMP_RELEASE_DOWNLOAD_BASE_URL,
  OMP_SUPPORTED_VERSION,
  findOmpReleaseAsset,
} = require('../../lib/agent-cli-provider/omp/release');

// Mirrors IsolationManager.imageForProvider: the derived tag is built from the base reference's
// NAME (tag/digest stripped, registry port kept), while the hash covers the FULL base reference.
function expectedVariantTag(baseImage, providerId, platform, install) {
  const hash = crypto
    .createHash('sha256')
    .update(`${baseImage}\n${platform || ''}\n${install}`)
    .digest('hex')
    .slice(0, 12);
  const { name } = IsolationManager.parseImageReference(baseImage);
  return `${name}-${providerId}-${hash}`;
}

const REGISTRY_HOST = /^[a-z0-9.-]+(?::\d+)?$/;
const NAME_COMPONENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TAG = /^\w[\w.-]{0,127}$/;

/**
 * Assert `reference` is a Docker reference a `docker run`/`docker build -t` would accept —
 * checked by hand-splitting rather than through the production parser, so this stays an
 * independent oracle. Rejects the malformed shapes a naive `${base}-${provider}` suffix produces:
 * `…@sha256:<hex>-omp-<hash>` (a digest with trailing junk) and `…:v2-omp-<hash>` (the suffix
 * swallowed into the tag).
 */
function assertValidImageReference(reference) {
  assert.ok(!reference.includes('@'), `derived reference must carry no digest: ${reference}`);

  const segments = reference.split('/');
  const hasRegistry =
    segments.length > 1 && (segments[0].includes('.') || segments[0].includes(':'));
  if (hasRegistry) {
    assert.match(segments.shift(), REGISTRY_HOST);
  }

  const last = segments.pop();
  for (const segment of segments) {
    assert.match(segment, NAME_COMPONENT);
  }

  const [name, ...tagParts] = last.split(':');
  assert.match(name, NAME_COMPONENT);
  assert.ok(tagParts.length <= 1, `at most one tag separator: ${reference}`);
  if (tagParts.length === 1) {
    assert.match(tagParts[0], TAG);
  }
}

module.exports = {
  IsolationManager,
  OMP_DOCKER_INSTALL_COMMAND,
  OMP_DOCKER_PLATFORM,
  OMP_RELEASE_DOWNLOAD_BASE_URL,
  OMP_SUPPORTED_VERSION,
  assert,
  assertValidImageReference,
  crypto,
  expectedVariantTag,
  findOmpReleaseAsset,
  getProviderMetadata,
};
