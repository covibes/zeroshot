const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const introducedGate = path.resolve(__dirname, '../../scripts/opcore-introduced-check.js');
const agentGate = path.resolve(__dirname, '../../scripts/opcore-agent-gate.js');

function oversizedFunction(name) {
  const statements = Array.from({ length: 81 }, (_, index) => `    let _value_${index} = 0;`);
  return [`pub fn ${name}() -> i32 {`, ...statements, '    0', '}', ''].join('\n');
}

function runOpcore(repo, args = [], checks = 'rust.function-metrics') {
  return spawnSync(process.execPath, [introducedGate, ...args, '--checks', checks], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_INDEX_FILE: path.join(repo, '.git', 'index'),
    },
  });
}

function runTypeScriptOpcore(repo) {
  return spawnSync(process.execPath, [introducedGate, '--checks', 'typescript.types'], {
    cwd: repo,
    encoding: 'utf8',
  });
}

function parseResult(run) {
  assert.ok(run.stdout, run.stderr);
  return JSON.parse(run.stdout);
}

function runAgentGate(content) {
  const repo = path.resolve(__dirname, '../..');
  const payload = JSON.stringify({
    tool_name: 'Write',
    tool_input: {
      file_path: 'tests/.tmp-opcore-agent-gate.rs',
      content,
    },
    cwd: repo,
  });
  return spawnSync(process.execPath, [agentGate, '--harness', 'codex', '--repo', repo], {
    cwd: repo,
    encoding: 'utf8',
    input: payload,
  });
}

function initializeRepo(repo, content) {
  fs.writeFileSync(path.join(repo, 'lib.rs'), content);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', 'lib.rs'], { cwd: repo });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Zeroshot Test',
      '-c',
      'user.email=test@zeroshot.invalid',
      'commit',
      '-qm',
      'baseline',
    ],
    { cwd: repo }
  );
}

function baselineDebtCase() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-opcore-introduced-'));
  const source = path.join(repo, 'lib.rs');
  try {
    initializeRepo(repo, oversizedFunction('existing_debt'));
    fs.appendFileSync(source, '// unrelated clean change\n');
    const unchangedDebt = runOpcore(repo);
    const unchangedDebtResult = parseResult(unchangedDebt);
    assert.strictEqual(unchangedDebt.status, 0, unchangedDebt.stderr);
    assert.strictEqual(unchangedDebtResult.validationResult.status, 'passed');
    assert.ok(
      unchangedDebtResult.validationResult.diagnostics.every(
        (diagnostic) => diagnostic.code !== 'RUST_FUNCTION_LINES'
      )
    );

    fs.appendFileSync(source, `\n${oversizedFunction('introduced_debt')}`);
    const introducedDebt = runOpcore(repo);
    const introducedDebtResult = parseResult(introducedDebt);
    assert.strictEqual(introducedDebt.status, 1, introducedDebt.stderr);
    assert.strictEqual(introducedDebtResult.validationResult.status, 'policy_failure');
    assert.ok(
      introducedDebtResult.validationResult.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'RUST_FUNCTION_LINES' &&
          diagnostic.message.includes('introduced_debt')
      )
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function stagedIndexCase() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-opcore-staged-'));
  const source = path.join(repo, 'lib.rs');
  try {
    initializeRepo(repo, 'pub fn baseline() -> i32 {\n    0\n}\n');
    fs.writeFileSync(source, oversizedFunction('staged_violation'));
    execFileSync('git', ['add', 'lib.rs'], { cwd: repo });
    fs.writeFileSync(source, 'pub fn unstaged_replacement() -> i32 {\n    0\n}\n');

    const staged = runOpcore(repo, ['--staged']);
    const result = parseResult(staged);
    assert.strictEqual(staged.status, 1, staged.stderr);
    assert.ok(
      result.validationResult.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'RUST_FUNCTION_LINES' &&
          diagnostic.message.includes('staged_violation')
      )
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function deletedFileCase() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-opcore-delete-'));
  const retained = path.join(repo, 'retained.rs');
  try {
    initializeRepo(repo, 'pub fn removed() -> i32 {\n    0\n}\n');
    fs.writeFileSync(retained, 'pub fn retained() -> i32 {\n    0\n}\n');
    execFileSync('git', ['add', 'retained.rs'], { cwd: repo });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Zeroshot Test',
        '-c',
        'user.email=test@zeroshot.invalid',
        'commit',
        '-qm',
        'add retained source',
      ],
      { cwd: repo }
    );
    fs.unlinkSync(path.join(repo, 'lib.rs'));
    fs.appendFileSync(retained, '// retained source remains in validation scope\n');

    const run = runOpcore(repo, [], 'rust.fmt');
    const result = parseResult(run);
    assert.strictEqual(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.strictEqual(result.validationResult.status, 'passed');
    assert.ok(
      result.validationResult.diagnostics.every(
        (diagnostic) => !diagnostic.message.includes('lib.rs` does not exist')
      )
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function specializedTypeScriptAuthorityCase() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-opcore-typescript-'));
  try {
    fs.mkdirSync(path.join(repo, 'src/target'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'tsconfig.target.json'),
      JSON.stringify({
        compilerOptions: {
          allowImportingTsExtensions: true,
          module: 'nodenext',
          moduleResolution: 'nodenext',
          noEmit: true,
          strict: true,
        },
        include: ['src/target/**/*.ts'],
      })
    );
    fs.writeFileSync(path.join(repo, 'src/target/value.ts'), 'export const value = 1;\n');
    fs.writeFileSync(
      path.join(repo, 'src/target/main.ts'),
      "import { value } from './value.ts';\nexport const baseline = value;\n"
    );
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Zeroshot Test',
        '-c',
        'user.email=test@zeroshot.invalid',
        'commit',
        '-qm',
        'baseline',
      ],
      { cwd: repo }
    );
    fs.appendFileSync(path.join(repo, 'src/target/main.ts'), 'export const introduced = value;\n');

    const run = runTypeScriptOpcore(repo);
    const result = parseResult(run);
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(result.validationResult.status, 'passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function agentGateCase() {
  const clean = runAgentGate('pub fn clean() -> i32 {\n    0\n}\n');
  assert.strictEqual(clean.status, 0, clean.stderr);

  const violation = runAgentGate(oversizedFunction('introduced_by_agent'));
  assert.strictEqual(violation.status, 2, violation.stderr);
  assert.match(violation.stderr, /status=policy_failure/);
  assert.doesNotMatch(violation.stderr, /timed out/i);
}

describe('Opcore introduced-change gate', function () {
  this.timeout(90000);

  it('ignores baseline debt but blocks a newly introduced violation', baselineDebtCase);
  it('validates the staged index rather than an unstaged replacement', stagedIndexCase);
  it('does not validate a path after it is deleted', deletedFileCase);
  it('uses the specialized TypeScript project authority', specializedTypeScriptAuthorityCase);
  it(
    'allows a clean pre-write and blocks an introduced violation within its deadline',
    agentGateCase
  );
});
