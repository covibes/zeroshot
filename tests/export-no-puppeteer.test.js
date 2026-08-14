/**
 * Regression: the `export` command used to depend on puppeteer purely to
 * convert an already-built HTML transcript into a PDF. That pulled a ~150MB
 * headless Chrome into every install (and frequently failed to download).
 *
 * Export now writes print-ready HTML directly (open in a browser and
 * Print -> Save as PDF). puppeteer must not return as a dependency, and the
 * export path must not launch a browser at runtime.
 */
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

describe('export command has no puppeteer footprint', () => {
  it('does not declare puppeteer in any dependency bucket', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    for (const bucket of [
      'dependencies',
      'optionalDependencies',
      'devDependencies',
      'peerDependencies',
    ]) {
      expect(pkg[bucket] || {}, `${bucket} should not contain puppeteer`).to.not.have.property(
        'puppeteer'
      );
    }
  });

  it('does not launch a browser in the CLI export path', () => {
    const cli = fs.readFileSync(path.join(repoRoot, 'cli', 'index.js'), 'utf8');
    expect(cli, 'export must not launch puppeteer').to.not.match(/puppeteer\.launch/);
    expect(cli, "export must not import('puppeteer') at runtime").to.not.match(
      /import\(\s*['"]puppeteer['"]\s*\)/
    );
  });

  it('defaults the export format to html', () => {
    const cli = fs.readFileSync(path.join(repoRoot, 'cli', 'index.js'), 'utf8');
    expect(cli).to.match(/Export format: json, trace, semantic, markdown, html/);
  });
});
