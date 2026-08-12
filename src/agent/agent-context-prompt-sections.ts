import type { AgentContextConfig, JsonSchema, LegacyOutputFormat } from './agent-context-types';

interface InstructionsSectionParams {
  config: AgentContextConfig;
  selectedPrompt?: string | null;
  id: string;
}

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

export = {
  buildInstructionsSection,
  buildJsonSchemaSection,
  buildLegacyOutputSchemaSection,
};
