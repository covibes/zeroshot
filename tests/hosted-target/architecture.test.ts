import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Walk up from cwd to find package.json with our package name
function findRepoRoot(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      const content = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      if (content.name === '@the-open-engine/zeroshot') return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Could not find repo root');
}

const repoRoot = findRepoRoot();

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    if (entry.isFile()) files.push(full);
  }
  return files;
}

function readSource(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function relative(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

describe('architecture isolation', () => {
  const clusterDir = path.join(repoRoot, 'src', 'cluster');
  const hostedTargetDir = path.join(repoRoot, 'src', 'hosted-target');

  it('src/cluster/ does not import from src/hosted-target/', () => {
    const clusterFiles = walk(clusterDir).filter((f) => f.endsWith('.ts') || f.endsWith('.js'));
    const violations: string[] = [];

    for (const file of clusterFiles) {
      const content = readSource(file);
      if (content.includes('hosted-target') || content.includes('hosted_target')) {
        violations.push(relative(file));
      }
    }

    assert.deepEqual(
      violations,
      [],
      `src/cluster/ must not import from src/hosted-target/. Violations: ${violations.join(', ')}`,
    );
  });

  it('src/hosted-target/ does not import from src/cluster/', () => {
    const hostedFiles = walk(hostedTargetDir).filter(
      (f) => f.endsWith('.ts') || f.endsWith('.js'),
    );
    const violations: string[] = [];

    for (const file of hostedFiles) {
      const content = readSource(file);
      if (
        content.includes("from '../cluster") ||
        content.includes("from '../../cluster") ||
        content.includes('require(') && content.includes('cluster')
      ) {
        violations.push(relative(file));
      }
    }

    assert.deepEqual(
      violations,
      [],
      `src/hosted-target/ must not import from src/cluster/. Violations: ${violations.join(', ')}`,
    );
  });

  it('src/hosted-target/ does not import orchestrator or local cluster internals', () => {
    const hostedFiles = walk(hostedTargetDir).filter(
      (f) => f.endsWith('.ts') || f.endsWith('.js'),
    );
    const forbidden = ['orchestrator', 'message-bus', 'ledger', 'logic-engine', 'agent-wrapper'];
    const violations: string[] = [];

    for (const file of hostedFiles) {
      const content = readSource(file);
      for (const term of forbidden) {
        if (content.includes(term)) {
          violations.push(`${relative(file)} references "${term}"`);
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `src/hosted-target/ must not reference local internals. Violations: ${violations.join(', ')}`,
    );
  });

  it('src/hosted-target/ does not reference graph/input/OECP types', () => {
    const hostedFiles = walk(hostedTargetDir).filter(
      (f) => f.endsWith('.ts') || f.endsWith('.js'),
    );
    const forbidden = [
      'ClusterGraph',
      'ClusterInput',
      'OecpRequest',
      'OecpResponse',
      'OecpMessage',
      'ShellCommand',
    ];
    const violations: string[] = [];

    for (const file of hostedFiles) {
      const content = readSource(file);
      for (const term of forbidden) {
        if (content.includes(term)) {
          violations.push(`${relative(file)} references "${term}"`);
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `src/hosted-target/ must not reference graph/input/OECP types. Violations: ${violations.join(', ')}`,
    );
  });
});
