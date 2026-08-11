'use strict';

const PRIVATE_MARKER = 'ZEROSHOT_PRIVATE_HOSTED_CLI_CANDIDATE_DO_NOT_PUBLISH';
const COMMAND_MANIFEST = Object.freeze([
  'target add <name> --url <https-origin>',
  'target login <name>',
  'target list [--json]',
  'target remove <name> [--force]',
  'target setup <name> --repository <owner/name> [--base <branch-or-sha>] ' +
    '[--target-branch <branch>] --runtime-config <file>',
  'target status <name> <intent-id> [--json]',
  'target cancel <name> <intent-id>',
  'capsule create --target <name> [--label <label>] [--size <size>]',
  'capsule terminate <capsule-id> --target <name>',
  'run --graph <graph.json> --input <input.json> --target <name> (--pr|--ship) ' +
    '[--config <cluster.json>] [--size <size>] [--submission-key <uuid>] [-d]',
  'attach <intent-id> --target <name>',
  'list --target <name> [--limit <n>] [--json]',
  'status <capsule-id> --target <name> [--json]',
  'stop <capsule-id> --target <name> [--force]',
]);

module.exports = { COMMAND_MANIFEST, PRIVATE_MARKER };
