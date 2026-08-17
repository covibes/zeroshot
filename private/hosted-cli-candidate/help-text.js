'use strict';

const TARGET_HELP = `
Workflow:
  1. zeroshot target add <name> --url <https-origin>
  2. zeroshot target login <name>
  3. zeroshot target setup <name> --repository <owner/name> --runtime-config <file>
  4. zeroshot run --target <name> --title <title> --graph <file> --input <file> --ship

Run \`zeroshot target <command> --help\` for command details.
`;
const TARGET_SETUP_HELP = `
Runtime configuration:
  provider       Stable label for the model API used by the run.
  harness        Agent program Zeroshot uses to call that API; defaults to provider.
  model          Optional model selector understood by the harness.
  environment    Inline values or {"from":"LOCAL_ENV_NAME"} references.
  files          Inline text or {"from":"local/path"} references.
  settings       Zeroshot settings supplied to the remote cluster.

The runtime file is read for every run. Setup stores its path, not resolved secrets.
`;
const HOSTED_RUN_HELP = `
Remote execution with --target:
  --title is required and is shown in Zeroshot Cloud.
  --graph and --input are required explicit JSON files.
  Keep the candidate graph unchanged; put the work request in the input.
  --pr or --ship is required for Git delivery.
  Omit --config to use Zeroshot's built-in coordinator.
  Add --config <file> to use a declarative custom cluster.
  Runs follow by default; --detach and Ctrl+C detach without cancelling.
  --submission-key retries only an unchanged, fully resolved request.

Examples:
  zeroshot run --target team --title "Review" --graph graph.json --input input.json --ship
  zeroshot run --target team --title "Review" --graph graph.json --input input.json --config cluster.json --ship
`;

module.exports = { HOSTED_RUN_HELP, TARGET_HELP, TARGET_SETUP_HELP };
