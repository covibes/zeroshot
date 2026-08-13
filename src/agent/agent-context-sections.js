const { readFileSync } = require('fs');
const { join, resolve } = require('path');

const { isPlatformMismatchReason } = require('./validation-platform');

const EXAMPLE_PRIMITIVE_VALUES = {
  boolean: true,
  number: 0,
  integer: 0,
};

function generateExampleValue(propSchema, key) {
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

  return EXAMPLE_PRIMITIVE_VALUES[propSchema.type];
}

function generateExampleFromSchema(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return null;
  }

  const example = {};

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const value = generateExampleValue(propSchema, key);
    if (value !== undefined) {
      example[key] = value;
    }
  }

  return example;
}

function buildAutonomousSection() {
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

function buildOutputStyleSection() {
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

function buildGitOperationsSection() {
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

function buildHeaderContext({ id, role, iteration, isIsolated }) {
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

function buildInstructionsSection({ config, selectedPrompt, id }) {
  const promptText =
    selectedPrompt || (typeof config.prompt === 'string' ? config.prompt : config.prompt?.system);

  if (promptText) {
    return `## Instructions\n\n${promptText}\n\n`;
  }

  if (config.prompt && typeof config.prompt !== 'string' && !config.prompt?.system) {
    throw new Error(
      `Agent "${id}" has invalid prompt format. ` +
        `Expected string or object with .system property, got: ${JSON.stringify(config.prompt).slice(0, 100)}...`
    );
  }

  return '';
}

function hasIgnoredRepoToolingError(error) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)
  );
}

function resolveRepoToolingRoots({ config, worktree }) {
  return Array.from(
    new Set(
      [worktree?.path, config?.cwd, process.cwd()]
        .filter((value) => typeof value === 'string' && value.trim() !== '')
        .map((value) => resolve(value))
    )
  );
}

function buildRepoToolingSection({ config, worktree }) {
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

function buildLegacyOutputSchemaSection(config) {
  if (!config.prompt?.outputFormat) {
    return '';
  }

  const rules = (config.prompt.outputFormat.rules || []).map((rule) => `- ${rule}`).join('\n');

  return [
    '## Output Schema (REQUIRED)',
    '',
    '```json',
    JSON.stringify(config.prompt.outputFormat.example, null, 2),
    '```',
    '',
    'STRING VALUES IN THIS SCHEMA: Dense. Factual. No filler words. No pleasantries.',
    rules,
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildJsonSchemaSection(config) {
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

function shouldKeepCannotValidate(criteria, ignoreReason, seenIds) {
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

function collectCannotValidateCriteria(prevValidations, options = {}) {
  const cannotValidateCriteria = [];
  const seenIds = new Set();
  const ignoreReason = options.ignoreReason;

  for (const msg of prevValidations) {
    const criteriaResults = msg.content?.data?.criteriaResults;
    if (!Array.isArray(criteriaResults)) {
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

function buildCannotValidateSection(cannotValidateCriteria) {
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

function buildValidatorSkipSection({ role, messageBus, cluster, isolation }) {
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

function buildTriggeringMessageSection(triggeringMessage) {
  const lines = [
    '',
    '## Triggering Message',
    '',
    `Topic: ${triggeringMessage.topic}`,
    `Sender: ${triggeringMessage.sender}`,
  ];

  if (triggeringMessage.id) {
    lines.push(`Message ID: ${triggeringMessage.id}`);
  }
  if (typeof triggeringMessage.timestamp === 'number') {
    lines.push(`Timestamp: ${new Date(triggeringMessage.timestamp).toISOString()}`);
  }
  if (triggeringMessage.metadata && typeof triggeringMessage.metadata === 'object') {
    lines.push(`Metadata: ${JSON.stringify(triggeringMessage.metadata, null, 2)}`);
  }

  if (triggeringMessage.content?.text) {
    lines.push('', triggeringMessage.content.text);
  }
  if (triggeringMessage.content?.data !== undefined) {
    lines.push('', `Data: ${JSON.stringify(triggeringMessage.content.data, null, 2)}`);
  }

  return `${lines.join('\n')}\n`;
}

module.exports = {
  buildHeaderContext,
  buildInstructionsSection,
  buildJsonSchemaSection,
  buildLegacyOutputSchemaSection,
  buildRepoToolingSection,
  buildTriggeringMessageSection,
  buildValidatorSkipSection,
};
