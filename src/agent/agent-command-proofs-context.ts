type StringList = string[];

interface CommandProof {
  id: string;
  profile: string;
  command: string;
  scope?: string;
  description?: string;
}

interface AgentCommandProofConfig {
  role?: string;
  commandProofs?: unknown;
}

interface CommandProofsModule {
  normalizeCommandProofs(value: unknown): CommandProof[];
}

function isCommandProofsModule(value: unknown): value is CommandProofsModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'normalizeCommandProofs' in value &&
    typeof value.normalizeCommandProofs === 'function'
  );
}

const commandProofsModule: unknown = require('../command-proofs');
if (!isCommandProofsModule(commandProofsModule)) {
  throw new TypeError('command-proofs must export normalizeCommandProofs');
}
const normalizeCommandProofs = commandProofsModule.normalizeCommandProofs;

function appendProofDetails(lines: StringList, proof: CommandProof, index: number): void {
  const scope = proof.scope ? `, scope: ${proof.scope}` : '';
  lines.push(`${index + 1}. id: ${proof.id}, profile: ${proof.profile}${scope}`);
  if (proof.description) {
    lines.push(`   description: ${proof.description}`);
  }
  lines.push(`   command: ${proof.command}`);
  lines.push(`   helper: zeroshot cmdproof check ${proof.id}`);
}

function buildWorkerInstructions(lines: StringList): void {
  lines.push(
    '',
    'For these exact commands:',
    '- Run `zeroshot cmdproof check <id>` instead of the raw command.',
    '- Treat the helper exit code as the command exit code.',
    '- If you need to mention evidence, include the helper output and the configured command id.',
    ''
  );
}

function buildValidatorInstructions(lines: StringList): void {
  lines.push(
    '',
    'For proof-backed validation:',
    '- Run `zeroshot cmdproof check <id>` before considering the raw command.',
    '- Use the helper output as quality-gate evidence.',
    '- Only run the raw command directly if the helper itself is unavailable.',
    ''
  );
}

function buildCommandProofsSection(config: AgentCommandProofConfig): string {
  const proofs = normalizeCommandProofs(config.commandProofs);
  if (proofs.length === 0) {
    return '';
  }

  const lines = ['## Reusable Command Proofs', '', 'Configured proof-backed commands:'];
  proofs.forEach((proof, index) => appendProofDetails(lines, proof, index));

  if (config.role === 'validator') {
    buildValidatorInstructions(lines);
  } else {
    buildWorkerInstructions(lines);
  }

  return lines.join('\n');
}

export = {
  buildCommandProofsSection,
};
