'use strict';

const PRIVATE_MARKER = 'ZEROSHOT_PRIVATE_HOSTED_CLI_CANDIDATE_DO_NOT_PUBLISH';
const FIXTURE_DIGEST = 'sha256:6636d50cd60067241a50d1ee027d86fc1738aa933f086d8bb2c496c5be31b85e';
const COMMAND_MANIFEST = Object.freeze([
  'target add <name> --url <https-origin>',
  'target login <name>',
  'target list [--json]',
  'target remove <name> [--force]',
  'target setup <name> --repository <owner/name> --provider codex-openrouter',
  'capsule create --target <name> [--label <label>] [--size <size>]',
  'capsule terminate <capsule-id> --target <name>',
  'run --graph <graph.json> --input <input.json> --target <name> [-d]',
  'list --target <name> [--limit <n>] [--json]',
  'status <capsule-id> --target <name> [--json]',
  'stop <capsule-id> --target <name> [--force]',
]);

module.exports = { COMMAND_MANIFEST, FIXTURE_DIGEST, PRIVATE_MARKER };
