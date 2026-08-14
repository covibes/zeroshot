#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..', 'cli');
const sources = fs
  .readdirSync(root)
  .filter((name) => name.endsWith('.ts'))
  .sort();
const outputs = [];

for (const name of sources) {
  const sourcePath = path.join(root, name);
  const result = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    fileName: sourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const errors = (result.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  );
  if (errors.length > 0) {
    throw new Error(
      ts.formatDiagnostics(errors, {
        getCanonicalFileName: String,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      })
    );
  }
  outputs.push([path.join(root, name.replace(/\.ts$/, '.js')), result.outputText]);
}

for (const [outputPath, content] of outputs) fs.writeFileSync(outputPath, content, { mode: 0o755 });
