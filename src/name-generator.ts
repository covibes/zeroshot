/**
 * Human-readable name generator (like Weights & Biases)
 * Generates names like "wandering-forest-42" or "bright-star-17"
 *
 * No prefix - short forms used everywhere for simplicity
 */

import nameGenerator = require('./name-generator-shared');

const { generateReadableName, generateNameSuffix } = nameGenerator;

/**
 * Generate a human-readable name.
 * The deprecated prefix remains ignored for backwards compatibility.
 */
function generateName(_prefix = ''): string {
  return generateReadableName();
}

/**
 * Generate a short unique suffix for collision prevention.
 */
function generateSuffix(): string {
  return generateNameSuffix();
}

export = { generateName, generateSuffix };
