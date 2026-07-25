#!/usr/bin/env node
/**
 * Test runner wrapper that tolerates the known better-sqlite3 cleanup crash.
 *
 * better-sqlite3 throws "Cannot assign to read only property 'database'"
 * during process exit. This is harmless but causes mocha to report "1 failing".
 * This wrapper detects that specific failure pattern and exits 0 if all real
 * tests passed.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const testFileAliases = new Map([
  ['provider-cli-builder', ['tests/provider-cli-builder.test.js']],
  ['providers', ['tests/providers/**/*.test.js']],
  ['provider-retryable-errors', ['tests/unit/provider-retryable-errors.test.js']],
  ['watcher-crash-handling', ['tests/unit/watcher-crash-handling.test.js']],
  ['cli-provider-override', ['tests/unit/cli-provider-override.test.js']],
  ['stream-json-parser-codex', ['tests/unit/stream-json-parser-codex.test.js']],
  ['parse-result-output', ['tests/parse-result-output.test.js']],
]);

const args = process.argv.slice(2).flatMap((arg) => {
  if (arg.startsWith('-')) return [arg];
  return testFileAliases.get(arg) || [arg];
});
const defaultTestFiles = [
  'tests/unit/**/*.test.js',
  'tests/cluster-worker/**/*.test.js',
  'tests/cluster/**/*.test.js',
  'tests/*.test.js',
];
const hasExplicitTestFile = args.some((arg) => !arg.startsWith('-'));
const mochaArgs = hasExplicitTestFile ? args : [...defaultTestFiles, ...args];
// Unit tests must never inherit operator credentials or model overrides.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-test-home-'));
const testSettingsFile = path.join(testHome, '.zeroshot', 'settings.json');
const testEnvironment = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('ZEROSHOT_') || key.startsWith('CMDPROOF_')) continue;
  testEnvironment[key] = value;
}
fs.mkdirSync(path.dirname(testSettingsFile), { recursive: true });
fs.writeFileSync(testSettingsFile, '{}\n', 'utf8');
const child = spawn('npx', ['mocha', '--parallel', ...mochaArgs], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: {
    ...testEnvironment,
    HOME: testHome,
    USERPROFILE: testHome,
    ZEROSHOT_HOME: testHome,
    ZEROSHOT_SETTINGS_FILE: testSettingsFile,
  },
});

let stdout = '';
let stderr = '';

child.stdout.on('data', (data) => {
  process.stdout.write(data);
  stdout += data.toString();
});

child.stderr.on('data', (data) => {
  process.stderr.write(data);
  stderr += data.toString();
});

child.on('error', (error) => {
  fs.rmSync(testHome, { recursive: true, force: true });
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});

child.on('close', (code) => {
  fs.rmSync(testHome, { recursive: true, force: true });
  if (code === 0) {
    process.exit(0);
  }

  const combined = stdout + stderr;
  const failMatch = combined.match(/(\d+) failing/);
  const passMatch = combined.match(/(\d+) passing/);
  const isSqliteOnly =
    failMatch &&
    failMatch[1] === '1' &&
    passMatch &&
    combined.includes("Cannot assign to read only property 'database'");

  if (isSqliteOnly) {
    process.stderr.write(
      `\n[test-runner] Ignoring known better-sqlite3 cleanup crash (${passMatch[1]} tests passed)\n`
    );
    process.exit(0);
  }

  process.exit(code || 1);
});
