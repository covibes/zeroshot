const fs = require('fs');
const path = require('path');

function curatedNotesPath(cwd, version) {
  return path.join(cwd, 'docs', 'releases', `v${version}.md`);
}

function readCuratedNotes(cwd, version) {
  const notesPath = curatedNotesPath(cwd, version);
  if (!fs.existsSync(notesPath)) return null;

  const notes = fs.readFileSync(notesPath, 'utf8').trim();
  if (!notes) {
    throw new Error(`Curated release notes are empty: ${notesPath}`);
  }
  return `${notes}\n`;
}

async function conventionalNotes(pluginConfig, context) {
  const generator = await import('@semantic-release/release-notes-generator');
  return generator.generateNotes(pluginConfig.conventional || {}, context);
}

async function generateNotesWithFallback(pluginConfig, context, fallback = conventionalNotes) {
  const version = context.nextRelease?.version;
  if (!version) throw new Error('nextRelease.version is required to generate release notes');

  const curated = readCuratedNotes(context.cwd || process.cwd(), version);
  if (curated) return curated;
  const generated = await fallback(pluginConfig, context);
  return generated;
}

async function generateNotes(pluginConfig, context) {
  const notes = await generateNotesWithFallback(pluginConfig, context);
  return notes;
}

module.exports = {
  curatedNotesPath,
  generateNotes,
  generateNotesWithFallback,
  readCuratedNotes,
};
