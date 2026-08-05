const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    if (entry.isFile()) files.push(full);
  }
  return files;
}

function relative(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

const providerPolicyNames = [
  'claude',
  'codex',
  'gateway',
  'gemini',
  'opencode',
  'pi',
  'kiro',
  'copilot',
  'anthropic',
  'openai',
  'google',
];

function quotedProviderNames(name) {
  return [`'${name}'`, `"${name}"`];
}

function isWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function nextNonWhitespaceIndex(source, start) {
  let index = start;
  while (index < source.length && isWhitespace(source[index])) index += 1;
  return index;
}

function containsCasePolicy(source, quotedName) {
  let index = source.indexOf('case');
  while (index !== -1) {
    const valueIndex = nextNonWhitespaceIndex(source, index + 'case'.length);
    if (source.startsWith(quotedName, valueIndex)) return true;
    index = source.indexOf('case', index + 1);
  }
  return false;
}

function containsObjectKeyPolicy(source, quotedName) {
  let index = source.indexOf(quotedName);
  while (index !== -1) {
    const suffixIndex = nextNonWhitespaceIndex(source, index + quotedName.length);
    if (source[suffixIndex] === ':') return true;
    index = source.indexOf(quotedName, index + 1);
  }
  return false;
}

function containsForbiddenProviderPolicy(source) {
  return providerPolicyNames.some((name) =>
    quotedProviderNames(name).some(
      (quotedName) =>
        containsCasePolicy(source, quotedName) || containsObjectKeyPolicy(source, quotedName)
    )
  );
}

test('live runtime paths only import the built provider helper through approved facades', () => {
  const allowedHelperImports = new Set([
    'lib/provider-names.js',
    'src/providers/index.js',
    'task-lib/provider-helper-runtime.js',
    'task-lib/omp-sdk-runtime.js',
  ]);
  const runtimeFiles = ['src', 'lib', 'cli', 'task-lib']
    .flatMap((dir) => walk(path.join(repoRoot, dir)))
    .filter((file) => /\.(js|mjs|cjs|ts)$/.test(file))
    .filter((file) => !relative(file).startsWith('src/agent-cli-provider/'))
    .filter((file) => !relative(file).startsWith('lib/agent-cli-provider/'));

  const offenders = runtimeFiles
    .filter((file) => /agent-cli-provider/.test(fs.readFileSync(file, 'utf8')))
    .filter((file) => !allowedHelperImports.has(relative(file)))
    .map(relative);

  assert.deepEqual(offenders, []);
});

test('runtime paths do not import helper TypeScript sources directly', () => {
  const runtimeFiles = ['src', 'lib', 'cli', 'task-lib']
    .flatMap((dir) => walk(path.join(repoRoot, dir)))
    .filter((file) => /\.(js|mjs|cjs|ts)$/.test(file))
    .filter((file) => !relative(file).startsWith('src/agent-cli-provider/'))
    .filter((file) => !relative(file).startsWith('lib/agent-cli-provider/'));

  const offenders = runtimeFiles
    .filter((file) =>
      /src\/agent-cli-provider|\.\.\/src\/agent-cli-provider/.test(fs.readFileSync(file, 'utf8'))
    )
    .map(relative);

  assert.deepEqual(offenders, []);
});

test('deleted duplicate provider implementation files stay deleted', () => {
  const deletedPatterns = [
    ['src/providers/anthropic', ['cli-builder.js', 'output-parser.js', 'models.js']],
    ['src/providers/openai', ['cli-builder.js', 'output-parser.js', 'models.js']],
    ['src/providers/google', ['cli-builder.js', 'output-parser.js', 'models.js']],
    ['src/providers/opencode', ['cli-builder.js', 'output-parser.js', 'models.js']],
  ];
  const existing = [];
  for (const [dir, files] of deletedPatterns) {
    for (const file of files) {
      const candidate = path.join(repoRoot, dir, file);
      if (fs.existsSync(candidate)) existing.push(relative(candidate));
    }
  }
  const claudeRecovery = path.join(repoRoot, 'task-lib', 'claude-recovery.js');
  if (fs.existsSync(claudeRecovery)) existing.push(relative(claudeRecovery));

  assert.deepEqual(existing, []);
});

test('provider id and alias switch policy stays inside provider registry and type declarations', () => {
  const helperFiles = walk(path.join(repoRoot, 'src', 'agent-cli-provider'))
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => !relative(file).startsWith('src/agent-cli-provider/adapters/'))
    .filter(
      (file) =>
        ![
          'src/agent-cli-provider/provider-registry.ts',
          'src/agent-cli-provider/types.ts',
        ].includes(relative(file))
    );

  const offenders = helperFiles
    .filter((file) => containsForbiddenProviderPolicy(fs.readFileSync(file, 'utf8')))
    .map(relative);

  assert.deepEqual(offenders, []);
});

test('preflight provider validation dispatches through registry metadata', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src', 'preflight.js'), 'utf8');

  assert.match(source, /getProviderMetadata\(providerName\)/);
  assert.match(source, /metadata\.command\.kind === 'configured-claude'/);
  assert.doesNotMatch(
    source,
    /validatorByProvider\s*=\s*\{[\s\S]*['"]codex['"]:[\s\S]*['"]gemini['"]:[\s\S]*['"]opencode['"]:/m
  );
});

test('stream log parser builds provider parsers from runtime provider list', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'lib', 'stream-json-parser.js'), 'utf8');

  assert.match(source, /listProviders\(\)\.map\(\(name\) => getProvider\(name\)\)/);
  assert.doesNotMatch(source, /providerOrder\s*=\s*\[/);
  assert.match(source, /const providerParsers = createProviderParsers\(\)/);
});

test('docker preset surfaces derive provider entries from registry', () => {
  const dockerSource = fs.readFileSync(path.join(repoRoot, 'lib', 'docker-config.js'), 'utf8');
  const cliSource = fs.readFileSync(path.join(repoRoot, 'cli', 'index.js'), 'utf8');

  assert.match(dockerSource, /listProviderMetadata\(\)/);
  assert.doesNotMatch(
    dockerSource,
    /claude:\s*\{[\s\S]*codex:\s*\{[\s\S]*gemini:\s*\{[\s\S]*opencode:\s*\{[\s\S]*pi:\s*\{/m
  );
  assert.match(cliSource, /Object\.keys\(MOUNT_PRESETS\)\.join\(', '\)/);
});

test('CLI provider TUI entrypoints derive from registry provider list', () => {
  const cliSource = fs.readFileSync(path.join(repoRoot, 'cli', 'index.js'), 'utf8');

  assert.match(cliSource, /for \(const providerName of VALID_PROVIDERS\)/);
  assert.doesNotMatch(cliSource, /registerTuiEntrypoint\(['"]codex['"]/);
  assert.doesNotMatch(cliSource, /registerTuiEntrypoint\(['"]claude['"]/);
  assert.doesNotMatch(cliSource, /registerTuiEntrypoint\(['"]gemini['"]/);
  assert.doesNotMatch(cliSource, /registerTuiEntrypoint\(['"]opencode['"]/);
});

test('task runner passes provider args to watcher once', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'task-lib', 'runner.js'), 'utf8');

  assert.match(source, /finalArgs:\s*commandSpec\.args/);
  assert.match(source, /delete watcherCommandSpec\.args/);
  assert.doesNotMatch(source, /commandSpec:\s*commandSpec[,}]/);
});
