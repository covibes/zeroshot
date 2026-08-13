#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const MATRIX_PATH = path.join(REPO_ROOT, 'phase1-evidence', 'purpose-agnostic-matrix.json');

function fail(errors) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function ontologyKey(ontology, dimensions) {
  return dimensions.map((dimension) => ontology[dimension]).join('|');
}

function main() {
  const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
  const errors = [];
  const tasks = Array.isArray(matrix.tasks) ? matrix.tasks : [];
  const axes = matrix.taskOntologyAxes || {};
  const dimensions = Object.keys(axes);
  const ontologyTasks = tasks.filter((task) => task.taskOntology);

  const ids = tasks.map((task) => task.id);
  const duplicateIds = sortedUnique(ids.filter((id, index) => ids.indexOf(id) !== index));
  if (duplicateIds.length) errors.push(`duplicate task ids: ${duplicateIds.join(', ')}`);
  if (dimensions.length === 0) errors.push('taskOntologyAxes is empty');
  if (ontologyTasks.length === 0) errors.push('no tasks carry taskOntology');

  for (const task of ontologyTasks) {
    const keys = Object.keys(task.taskOntology);
    const unknown = keys.filter((key) => !dimensions.includes(key));
    const missing = dimensions.filter((dimension) => !keys.includes(dimension));
    if (unknown.length) errors.push(`${task.id}: unknown ontology fields: ${unknown.join(', ')}`);
    if (missing.length) errors.push(`${task.id}: missing ontology fields: ${missing.join(', ')}`);

    for (const dimension of dimensions) {
      const value = task.taskOntology[dimension];
      if (!axes[dimension].includes(value)) {
        errors.push(`${task.id}: invalid ${dimension} value ${JSON.stringify(value)}`);
      }
    }
  }

  const coverage = {};
  for (const dimension of dimensions) {
    const observed = sortedUnique(ontologyTasks.map((task) => task.taskOntology[dimension]));
    const uncovered = axes[dimension].filter((value) => !observed.includes(value));
    coverage[dimension] = observed;
    if (uncovered.length)
      errors.push(`${dimension}: unexercised categories: ${uncovered.join(', ')}`);
  }

  const freezes = [
    ['finalHoldoutFreeze', 'final-holdout'],
    ['postFixHoldoutFreeze', 'post-fix-holdout'],
    ['finalProofHoldoutFreeze', 'final-proof-holdout'],
  ];
  for (const [freezeName, cohort] of freezes) {
    const declared = matrix[freezeName]?.cells;
    const actual = tasks.filter((task) => task.cohort === cohort).length;
    if (declared !== actual)
      errors.push(`${freezeName}: declares ${declared} cells but has ${actual}`);
  }

  if (errors.length) fail(errors);

  const vectors = ontologyTasks.map((task) => ontologyKey(task.taskOntology, dimensions));
  const coveredValues = Object.values(coverage).reduce((total, values) => total + values.length, 0);
  const cohortCounts = Object.entries(
    tasks.reduce((counts, task) => {
      counts[task.cohort] = (counts[task.cohort] || 0) + 1;
      return counts;
    }, {})
  )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cohort, count]) => `${cohort}=${count}`)
    .join(', ');

  console.log(`✅ ${tasks.length} matrix tasks (${cohortCounts})`);
  console.log(
    `✅ ${ontologyTasks.length} task-mechanics cases cover all ${coveredValues} values across ` +
      `${dimensions.length} ontology dimensions`
  );
  console.log(`✅ ${new Set(vectors).size}/${vectors.length} task-mechanics vectors are unique`);
  console.log('✅ frozen cohort declarations match their committed task counts');
}

main();
