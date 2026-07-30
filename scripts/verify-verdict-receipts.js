#!/usr/bin/env node
/**
 * Offline verification of validator verdict receipts.
 *
 * Takes an exported bundle and a keyring and reports whether every verdict was
 * signed by a trusted key while that key was trusted, and whether the sequence
 * has been altered. Needs no running cluster, no network, and no access to the
 * machine that produced the verdicts.
 *
 *   node scripts/verify-verdict-receipts.js --bundle ./verdicts.json --keyring ./keyring.json
 *
 * The keyring is a separate argument on purpose. A bundle carries a keyring
 * hint for convenience, but verifying an artifact with a key it supplied itself
 * proves only that it is internally consistent. Passing --trust-bundle-keyring
 * is supported for a quick structural check and says so in the output.
 *
 * Exit codes: 0 verified, 1 verification failed, 2 usage or input error.
 */

const fs = require('node:fs');
const path = require('node:path');

const { verifyReceiptChain } = require('../src/verdict-receipts');

function usage(message) {
  if (message) process.stderr.write(`error: ${message}\n\n`);
  process.stderr.write(
    [
      'Usage: verify-verdict-receipts.js --bundle <path> [--keyring <path>]',
      '',
      '  --bundle <path>            Exported verdict bundle (JSON).',
      '  --keyring <path>           Independently obtained keyring (JSON). Recommended.',
      '  --trust-bundle-keyring     Use the keyring inside the bundle. Structural check only.',
      '  --json                     Emit the full report as JSON.',
      '',
    ].join('\n')
  );
  process.exit(2);
}

const VALUE_FLAGS = new Map([
  ['--bundle', 'bundle'],
  ['--keyring', 'keyring'],
]);

function parseArgs(argv) {
  const args = { bundle: null, keyring: null, trustBundleKeyring: false, json: false };
  let pendingKey = null;

  for (const arg of argv) {
    if (pendingKey) {
      args[pendingKey] = arg;
      pendingKey = null;
    } else if (VALUE_FLAGS.has(arg)) {
      pendingKey = VALUE_FLAGS.get(arg);
    } else if (arg === '--trust-bundle-keyring') {
      args.trustBundleKeyring = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      usage();
    } else {
      usage(`unknown argument ${arg}`);
    }
  }

  if (pendingKey) usage(`${pendingKey} flag is missing its value`);
  return args;
}

function readJson(filePath, label) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) usage(`${label} not found: ${resolved}`);
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    usage(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.bundle) usage('--bundle is required');
  if (!args.keyring && !args.trustBundleKeyring) {
    usage('supply --keyring, or pass --trust-bundle-keyring for a structural check only');
  }

  const bundle = readJson(args.bundle, 'bundle');
  const receipts = Array.isArray(bundle.receipts) ? bundle.receipts : null;
  if (!receipts) usage('bundle has no receipts array');

  const keyring = args.keyring ? readJson(args.keyring, 'keyring') : bundle.keyring_hint;
  if (!keyring) usage('bundle contains no keyring_hint and no --keyring was supplied');

  let report;
  try {
    report = verifyReceiptChain(receipts, keyring);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(2);
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ ...report, trust_source: args.keyring ? 'independent_keyring' : 'bundle_keyring_hint' }, null, 2)}\n`
    );
  } else {
    process.stdout.write(renderReport(report, bundle, args));
  }

  process.exit(report.valid ? 0 : 1);
}

function renderReport(report, bundle, args) {
  const lines = [];
  lines.push('');
  lines.push(`Cluster        ${bundle.cluster_id ?? 'unknown'}`);
  lines.push(`Receipts       ${report.receipts_checked}`);
  lines.push(
    `Signatures     ${report.signatures_valid} valid, ${report.signatures_invalid} invalid`
  );
  lines.push(`Sequence       ${report.chain_intact ? 'intact' : 'ALTERED'}`);
  lines.push(
    `Trust source   ${args.keyring ? 'independent keyring' : 'keyring carried in the bundle (structural check only)'}`
  );
  lines.push('');

  const failures = report.results.filter((r) => !r.signature_valid || !r.chain_valid);
  if (failures.length > 0) {
    lines.push('Failures');
    for (const failure of failures) {
      lines.push(`  [${failure.index}] ${failure.message_id ?? 'unknown message'}`);
      if (!failure.signature_valid) lines.push(`      signature: ${failure.signature_reason}`);
      if (!failure.chain_valid) lines.push(`      sequence:  ${failure.chain_reason}`);
    }
    lines.push('');
  }

  lines.push(report.valid ? 'VERIFIED' : 'NOT VERIFIED');
  lines.push('');
  lines.push(`Establishes: ${report.establishes}`);
  lines.push('Does not establish:');
  for (const limit of report.does_not_establish) lines.push(`  - ${limit}`);
  lines.push('');

  return lines.join('\n');
}

if (require.main === module) main();

module.exports = { parseArgs, renderReport };
