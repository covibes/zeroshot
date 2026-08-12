import fs = require('fs');
import path = require('path');

import validationPlatform = require('./validation-platform');

interface JsonSchema {
  readonly type?: string;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, JsonSchema | null | undefined>>;
}

interface LegacyOutputFormat {
  readonly rules?: readonly string[];
  readonly example?: unknown;
}

interface PromptObject {
  readonly system?: string | null;
  readonly outputFormat?: LegacyOutputFormat | null;
}

interface AgentContextConfig {
  readonly prompt?: string | PromptObject | null;
  readonly cwd?: string | null;
  readonly jsonSchema?: JsonSchema | null;
  readonly outputFormat?: string | null;
}

interface WorktreeContext {
  readonly enabled?: boolean;
  readonly path?: string | null;
}

interface IsolationContext {
  readonly enabled?: boolean;
}

interface HeaderContextParams {
  id: string;
  role: string;
  iteration: number;
  isIsolated: boolean;
}

interface InstructionsSectionParams {
  config: AgentContextConfig;
  selectedPrompt?: string | null;
  id: string;
}

interface RepoToolingParams {
  config?: AgentContextConfig | null | undefined;
  worktree?: WorktreeContext | null | undefined;
}

interface ValidationCriterion {
  readonly status?: string;
  readonly id?: string;
  readonly reason?: string;
}

interface ValidationMessage {
  readonly content?: {
    readonly data?: {
      readonly criteriaResults?: readonly ValidationCriterion[] | null;
    } | null;
  } | null;
}

interface ValidationQuery {
  cluster_id: string;
  topic: 'VALIDATION_RESULT';
  since: number;
  limit: number;
}

interface ValidationMessageBus {
  query(criteria: ValidationQuery): readonly ValidationMessage[];
}

interface ValidationCluster {
  id: string;
  createdAt: number;
}

interface CannotValidateCriterion {
  id: string;
  reason: string;
}

interface CannotValidateOptions {
  ignoreReason?: ((reason: string | undefined) => boolean) | null;
}

interface ValidatorSkipParams {
  role: string;
  messageBus: ValidationMessageBus;
  cluster: ValidationCluster;
  isolation?: IsolationContext | null;
}

interface TriggeringMessage {
  topic: string;
  sender: string;
  content?: {
    text?: string | null;
  } | null;
}

const { readFileSync } = fs;
const { join, resolve } = path;
const { isPlatformMismatchReason } = validationPlatform;

const EXAMPLE_PRIMITIVE_VALUES: Readonly<Record<string, boolean | number>> = {
  boolean: true,
  number: 0,
  integer: 0,
};

function generateExampleValue(propSchema: JsonSchema | null | undefined, key: string): unknown {
  if (!propSchema) {
    return undefined;
  }

  if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
    return propSchema.enum[0];
  }

  if (propSchema.type === 'string') {
    return propSchema.description || `${key} value`;
  }

  if (propSchema.type === 'array') {
    return [];
  }

  if (propSchema.type === 'object') {
    return generateExampleFromSchema(propSchema) || {};
  }

  return propSchema.type === undefined ? undefined : EXAMPLE_PRIMITIVE_VALUES[propSchema.type];
}

function generateExampleFromSchema(
  schema: JsonSchema | null | undefined
): Record<string, unknown> | null {
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return null;
  }

  const example: Record<string, unknown> = {};

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const value = generateExampleValue(propSchema, key);
    if (value !== undefined) {
      example[key] = value;
    }
  }

  return example;
}

function buildAutonomousSection(): string {
  return [
    '## 🔴 CRITICAL: AUTONOMOUS EXECUTION REQUIRED',
    '',
    'You are running in a NON-INTERACTIVE cluster environment.',
    '',
    '**NEVER** use AskUserQuestion or ask for user input - there is NO user to respond.',
    '**NEVER** ask "Would you like me to..." or "Should I..." - JUST DO IT.',
    '**NEVER** wait for approval or confirmation - MAKE DECISIONS AUTONOMOUSLY.',
    '',
    'When facing choices:',
    '- Choose the option that maintains code quality and correctness',
    '- If unsure between "fix the code" vs "relax the rules" → ALWAYS fix the code',
    '- If unsure between "do more" vs "do less" → ALWAYS do what\'s required, nothing more',
    '',
  ].join('\n');
}

function buildOutputStyleSection(): string {
  return [
    '## 🔴 OUTPUT STYLE - NON-NEGOTIABLE',
    '',
    '**ALL OUTPUT: Maximum informativeness, minimum verbosity. NO EXCEPTIONS.**',
    '',
    'This applies to EVERYTHING you output:',
    '- Text responses',
    '- JSON schema values',
    '- Reasoning fields',
    '- Summary fields',
    '- ALL string values in structured output',
    '',
    'Rules:',
    '- Progress: "Reading auth.ts" NOT "I will now read the auth.ts file..."',
    '- Tool calls: NO preamble. Call immediately.',
    '- Schema strings: Dense facts. No filler. No fluff.',
    '- Errors: DETAILED (stack traces, repro). NEVER compress errors.',
    '- FORBIDDEN: "I\'ll help...", "Let me...", "I\'m going to...", "Sure!", "Great!", "Certainly!"',
    '',
    'Every token costs money. Waste nothing.',
    '',
  ].join('\n');
}

function buildGitOperationsSection(): string {
  return [
    '## 🚫 GIT OPERATIONS - FORBIDDEN',
    '',
    'NEVER commit, push, or create PRs. You only modify files.',
    'The git-pusher agent handles ALL git operations AFTER validators approve.',
    '',
    '- ❌ NEVER run: git add, git commit, git push, gh pr create',
    '- ❌ NEVER suggest committing changes',
    '- ✅ Only modify files and publish your completion message when done',
    '',
  ].join('\n');
}

function buildHeaderContext({ id, role, iteration, isIsolated }: HeaderContextParams): string {
  return [
    `You are agent "${id}" with role "${role}".`,
    '',
    `Iteration: ${iteration}`,
    '',
    buildAutonomousSection(),
    buildOutputStyleSection(),
    isIsolated ? '' : buildGitOperationsSection(),
  ]
    .filter(Boolean)
    .join('\n');
}

function buildInstructionsSection({
  config,
  selectedPrompt,
  id,
}: InstructionsSectionParams): string {
  const promptText =
    selectedPrompt || (typeof config.prompt === 'string' ? config.prompt : config.prompt?.system);

  if (promptText) {
    return `## Instructions\n\n${promptText}\n\n`;
  }

  if (config.prompt && typeof config.prompt !== 'string' && !config.prompt.system) {
    const serializedPrompt = JSON.stringify(config.prompt);
    throw new Error(
      `Agent "${id}" has invalid prompt format. ` +
        `Expected string or object with .system property, got: ${serializedPrompt.slice(0, 100)}...`
    );
  }

  return '';
}

function hasIgnoredRepoToolingError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)
  );
}

function resolveRepoToolingRoots({ config, worktree }: RepoToolingParams): string[] {
  return Array.from(
    new Set(
      [worktree?.path, config?.cwd, process.cwd()]
        .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
        .map((value) => resolve(value))
    )
  );
}

function buildRepoToolingSection({ config, worktree }: RepoToolingParams): string {
  for (const root of resolveRepoToolingRoots({ config, worktree })) {
    const skillPath = join(root, '.claude', 'skills', 'repo-tooling', 'SKILL.md');

    try {
      const content = readFileSync(skillPath, 'utf8').trim();
      if (content !== '') {
        return `${content}\n\n`;
      }
    } catch (error) {
      if (!hasIgnoredRepoToolingError(error)) {
        throw error;
      }
    }
  }

  return '';
}

function resolveLegacyOutputFormat(
  config: AgentContextConfig
): LegacyOutputFormat | null | undefined {
  return typeof config.prompt === 'string' ? undefined : config.prompt?.outputFormat;
}

function buildLegacyOutputSchemaSection(config: AgentContextConfig): string {
  const outputFormat = resolveLegacyOutputFormat(config);
  if (!outputFormat) {
    return '';
  }

  const rules = (outputFormat.rules || []).map((rule) => `- ${rule}`).join('\n');

  return [
    '## Output Schema (REQUIRED)',
    '',
    '```json',
    JSON.stringify(outputFormat.example, null, 2),
    '```',
    '',
    'STRING VALUES IN THIS SCHEMA: Dense. Factual. No filler words. No pleasantries.',
    rules,
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildJsonSchemaSection(config: AgentContextConfig): string {
  if (!config.jsonSchema || config.outputFormat !== 'json') {
    return '';
  }

  const lines = [
    '## 🔴 OUTPUT FORMAT - JSON ONLY',
    '',
    'Your response must be ONLY valid JSON. No other text before or after.',
    'Start with { and end with }. Nothing else.',
    '',
    'Required schema:',
    '```json',
    JSON.stringify(config.jsonSchema, null, 2),
    '```',
    '',
  ];

  const example = generateExampleFromSchema(config.jsonSchema);
  if (example) {
    lines.push('Example output:', '```json', JSON.stringify(example, null, 2), '```', '');
  }

  lines.push(
    'CRITICAL RULES:',
    '- Output ONLY the JSON object - no explanation, no thinking, no preamble',
    '- Use EXACTLY the enum values specified (case-sensitive)',
    '- Include ALL required fields',
    ''
  );

  return lines.join('\n');
}

function shouldKeepCannotValidate(
  criteria: ValidationCriterion,
  ignoreReason: CannotValidateOptions['ignoreReason'],
  seenIds: ReadonlySet<string>
): criteria is ValidationCriterion & { id: string } {
  if (criteria.status !== 'CANNOT_VALIDATE' || !criteria.id) {
    return false;
  }

  if (ignoreReason && ignoreReason(criteria.reason)) {
    return false;
  }

  if (seenIds.has(criteria.id)) {
    return false;
  }

  return true;
}

function isValidationCriteria(
  value: readonly ValidationCriterion[] | null | undefined
): value is readonly ValidationCriterion[] {
  return Array.isArray(value);
}

function collectCannotValidateCriteria(
  prevValidations: readonly ValidationMessage[],
  options: CannotValidateOptions = {}
): CannotValidateCriterion[] {
  const cannotValidateCriteria: CannotValidateCriterion[] = [];
  const seenIds = new Set<string>();
  const ignoreReason = options.ignoreReason;

  for (const msg of prevValidations) {
    const criteriaResults = msg.content?.data?.criteriaResults;
    if (!isValidationCriteria(criteriaResults)) {
      continue;
    }

    for (const criteria of criteriaResults) {
      if (!shouldKeepCannotValidate(criteria, ignoreReason, seenIds)) {
        continue;
      }

      seenIds.add(criteria.id);
      cannotValidateCriteria.push({
        id: criteria.id,
        reason: criteria.reason || 'No reason provided',
      });
    }
  }

  return cannotValidateCriteria;
}

function buildCannotValidateSection(
  cannotValidateCriteria: readonly CannotValidateCriterion[]
): string {
  if (cannotValidateCriteria.length === 0) {
    return '';
  }

  return [
    '',
    '## ⚠️ Permanently Unverifiable Criteria (SKIP THESE)',
    '',
    'The following criteria have PERMANENT environmental limitations (missing tools, no access).',
    'These limitations have not changed. Do NOT re-attempt verification.',
    'Mark these as CANNOT_VALIDATE again with the same reason.',
    '',
    ...cannotValidateCriteria.map((criteria) => `- **${criteria.id}**: ${criteria.reason}`),
    '',
  ].join('\n');
}

function buildValidatorSkipSection({
  role,
  messageBus,
  cluster,
  isolation,
}: ValidatorSkipParams): string {
  if (role !== 'validator') {
    return '';
  }

  const prevValidations = messageBus.query({
    cluster_id: cluster.id,
    topic: 'VALIDATION_RESULT',
    since: cluster.createdAt,
    limit: 50,
  });
  const ignoreReason = isolation?.enabled ? isPlatformMismatchReason : null;
  const cannotValidateCriteria = collectCannotValidateCriteria(prevValidations, { ignoreReason });

  return buildCannotValidateSection(cannotValidateCriteria);
}

function buildTriggeringMessageSection(triggeringMessage: TriggeringMessage): string {
  const lines = [
    '',
    '## Triggering Message',
    '',
    `Topic: ${triggeringMessage.topic}`,
    `Sender: ${triggeringMessage.sender}`,
  ];

  if (triggeringMessage.content?.text) {
    lines.push('', triggeringMessage.content.text);
  }

  return `${lines.join('\n')}\n`;
}

export = {
  buildHeaderContext,
  buildInstructionsSection,
  buildJsonSchemaSection,
  buildLegacyOutputSchemaSection,
  buildRepoToolingSection,
  buildTriggeringMessageSection,
  buildValidatorSkipSection,
};
