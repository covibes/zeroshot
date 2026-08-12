type StringList = string[];

interface RequiredQualityGate {
  id: string;
  scope?: string;
  description?: string;
  command?: string;
  profile?: string;
  proofProfile?: string;
}

interface AgentQualityGateConfig {
  role?: string;
  requiredQualityGates?: unknown;
}

interface QualityGatesModule {
  normalizeRequiredQualityGates(value: unknown): RequiredQualityGate[];
}

function isQualityGatesModule(value: unknown): value is QualityGatesModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'normalizeRequiredQualityGates' in value &&
    typeof value.normalizeRequiredQualityGates === 'function'
  );
}

const qualityGatesModule: unknown = require('../quality-gates');
if (!isQualityGatesModule(qualityGatesModule)) {
  throw new TypeError('quality-gates must export normalizeRequiredQualityGates');
}
const normalizeRequiredQualityGates = qualityGatesModule.normalizeRequiredQualityGates;

function appendGateDetails(lines: StringList, gate: RequiredQualityGate, index: number): void {
  lines.push(`${index + 1}. id: ${gate.id}${gate.scope ? `, scope: ${gate.scope}` : ''}`);
  if (gate.description) {
    lines.push(`   description: ${gate.description}`);
  }
  if (gate.command) {
    lines.push(`   command: ${gate.command}`);
  }
  if (gate.profile || gate.proofProfile) {
    lines.push(`   cmdproof profile: ${gate.profile || gate.proofProfile}`);
    lines.push(`   cmdproof helper: zeroshot cmdproof check ${gate.id}`);
  }
}

function buildRequiredQualityGatesSection(config: AgentQualityGateConfig): string {
  if (config.role !== 'validator') {
    return '';
  }

  const gates = normalizeRequiredQualityGates(config.requiredQualityGates);
  if (gates.length === 0) {
    return '';
  }

  const lines = [
    '## Required Handoff Quality Gates',
    '',
    'Before approving implementation handoff, publish one `qualityGates` entry for each configured required gate.',
    'Each entry must use the configured `id` and `scope` when a scope is configured.',
    '',
    'Configured gates:',
  ];

  gates.forEach((gate, index) => appendGateDetails(lines, gate, index));

  lines.push(
    '',
    'For each configured gate:',
    '- Run the configured command when one is provided by repo or cluster config.',
    '- For gates with a cmdproof profile, run `zeroshot cmdproof check <id>` before considering a raw command.',
    '- Put the command, numeric exit code, and string output in `evidence`.',
    '- Set `status` to `PASS` only when the gate completes successfully.',
    '- If a required gate fails, set `approved` to false and publish status `FAIL`.',
    '- If a required gate cannot run because its command, tool, or service is unavailable, ' +
      'set `approved` to false and publish status `UNAVAILABLE`.',
    '- Use `completedAt` or `timestamp` from the current validation run; ' +
      'stale evidence must be marked with `stale: true`.',
    ''
  );

  return lines.join('\n');
}

export = {
  buildRequiredQualityGatesSection,
};
