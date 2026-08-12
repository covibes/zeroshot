import nameGenerator from '../src/name-generator-shared.js';

const { generateReadableName, generateNameSuffix } = nameGenerator;

export function generateName(_prefix = ''): string {
  return generateReadableName('amber', 'forest');
}

export function generateSuffix(): string {
  return generateNameSuffix();
}
