'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OPENRPC_PATH = path.join(ROOT, 'protocol/openengine-cluster/v1/openrpc.json');
const SCHEMA_PATH = path.join(ROOT, 'protocol/openengine-cluster/v1/schema.json');
const PROTOCOL_RS = path.join(ROOT, 'crates/openengine-cluster-protocol/src/lib.rs');
const WATCH_RS = path.join(ROOT, 'crates/openengine-cluster-protocol/src/watch.rs');
const CLIENT_RS = path.join(ROOT, 'crates/openengine-cluster-client/src/lib.rs');
const OUTPUT_PATH = path.join(ROOT, 'src/cluster/generated/protocol.ts');
const SCHEMA_OUTPUT_PATH = path.join(ROOT, 'src/cluster/generated/protocol-schema.ts');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rustString(source, name) {
  const match = source.match(new RegExp(`pub const ${name}: &str = "([^"]+)";`));
  if (!match) throw new Error(`missing Rust string constant ${name}`);
  return match[1];
}

function rustNumber(source, name) {
  const match = source.match(new RegExp(`(?:pub )?const ${name}: [^=]+ = (-?[0-9_]+);`));
  if (!match) throw new Error(`missing Rust numeric constant ${name}`);
  return Number(match[1].replaceAll('_', ''));
}

function refName(ref) {
  const prefix = '#/$defs/';
  if (!ref.startsWith(prefix)) throw new Error(`unsupported non-local schema reference ${ref}`);
  return ref.slice(prefix.length);
}

function literal(value) {
  return JSON.stringify(value);
}

function renderCombination(schema) {
  for (const [keyword, operator] of [
    ['oneOf', ' | '],
    ['anyOf', ' | '],
    ['allOf', ' & '],
  ]) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    const combination = branches.map(schemaType).map(parenthesize).join(operator);
    const hasBase =
      schema.type !== undefined ||
      schema.properties !== undefined ||
      schema.additionalProperties !== undefined;
    if (!hasBase) return combination;
    const base = { ...schema };
    delete base[keyword];
    return `(${schemaType(base)}) & (${combination})`;
  }
  return undefined;
}

function renderObject(schema) {
  if (schema.properties) {
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties).map(
      ([name, value]) =>
        `readonly ${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${schemaType(value)};`
    );
    if (schema.additionalProperties && schema.additionalProperties !== false) {
      fields.push(`readonly [key: string]: ${schemaType(schema.additionalProperties)};`);
    }
    return `{ ${fields.join(' ')} }`;
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    const fields = schema.required.map((name) => `readonly ${JSON.stringify(name)}: unknown;`);
    return `{ ${fields.join(' ')} }`;
  }
  if (schema.additionalProperties && schema.additionalProperties !== false) {
    return `{ readonly [key: string]: ${schemaType(schema.additionalProperties)} }`;
  }
  return schema.type === 'object' ? 'Record<string, never>' : 'unknown';
}

function schemaType(schema) {
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (!schema || typeof schema !== 'object') throw new Error('invalid JSON schema');
  if ('$ref' in schema) return refName(schema.$ref);
  if ('const' in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(' | ') || 'never';
  const combination = renderCombination(schema);
  if (combination !== undefined) return combination;
  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => schemaType({ ...schema, type })).join(' | ');
  }
  switch (schema.type) {
    case 'null':
      return 'null';
    case 'boolean':
      return 'boolean';
    case 'integer':
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'array':
      return `ReadonlyArray<${schemaType(schema.items ?? true)}>`;
    case 'object':
    case undefined:
      return renderObject(schema);
    default:
      throw new Error(`unsupported JSON schema type ${String(schema.type)}`);
  }
}

function parenthesize(value) {
  return value.includes(' | ') || value.includes(' & ') ? `(${value})` : value;
}

function renderAlias(name, definition) {
  const inline = `export type ${name} = ${schemaType(definition)};`;
  if (Buffer.byteLength(inline) <= 120) return inline;
  const multiline = schemaType(definition).replaceAll('; ', ';\n  ').replaceAll(' | ', '\n  | ');
  return `export type ${name} =\n  ${multiline};`;
}

function renderSchemaModule(schema) {
  const encoded = JSON.stringify(schema);
  const chunks = encoded.match(/[\s\S]{1,72}/g) ?? [];
  const expression = chunks.map((chunk) => `  ${JSON.stringify(chunk)}`).join(' +\n');
  return (
    '// Generated from protocol/openengine-cluster/v1/schema.json. Do not edit.\n' +
    `export const CLUSTER_PROTOCOL_SCHEMA: unknown = JSON.parse(\n${expression}\n);\n`
  );
}

function generate() {
  const openrpc = readJson(OPENRPC_PATH);
  const schema = readJson(SCHEMA_PATH);
  const protocolRust = fs.readFileSync(PROTOCOL_RS, 'utf8');
  const watchRust = fs.readFileSync(WATCH_RS, 'utf8');
  const clientRust = fs.readFileSync(CLIENT_RS, 'utf8');
  const methods = openrpc.methods.map((method) => method.name);
  const subscriptionMethods = new Set([
    'watch',
    'logs',
    'agent/attach',
    'run/watch',
    'run/logs',
    'run/attach',
  ]);
  const unaryMethods = methods.filter((method) => !subscriptionMethods.has(method));
  const resultDefinitions = Object.fromEntries(
    openrpc.methods.map((method) => [method.name, method.result.schema.$ref.split('/').at(-1)])
  );
  const aliases = Object.entries(schema.$defs)
    .map(([name, definition]) => renderAlias(name, definition))
    .join('\n');

  return (
    `// Generated by scripts/generate-cluster-types.js from the checked-in Cluster Protocol v1 artifacts.\n// Do not edit this file by hand. Run npm run protocol:generate.\n\n` +
    `export const JSON_RPC_VERSION = ${literal(rustString(protocolRust, 'JSON_RPC_VERSION'))} as const;\n` +
    `export const PROTOCOL_VERSION = ${literal(rustString(protocolRust, 'PROTOCOL_VERSION'))} as const;\n` +
    `export const SUBSCRIPTION_QUEUE_CAPACITY = ${rustNumber(watchRust, 'DEFAULT_SUBSCRIPTION_QUEUE_CAPACITY')} as const;\n` +
    `export const MAX_FRAME_BYTES = ${rustNumber(clientRust, 'MAX_FRAME_BYTES')} as const;\n` +
    `export const CLUSTER_METHODS = ${JSON.stringify(methods)} as const;\n` +
    `export type ClusterMethod = (typeof CLUSTER_METHODS)[number];\n\n` +
    `export const UNARY_METHODS = ${JSON.stringify(unaryMethods)} as const;\n` +
    `export type UnaryClusterMethod = (typeof UNARY_METHODS)[number];\n` +
    `export const SUBSCRIPTION_METHODS = ${JSON.stringify([...subscriptionMethods])} as const;\n` +
    `export type SubscriptionMethod = (typeof SUBSCRIPTION_METHODS)[number];\n` +
    `export const METHOD_RESULT_DEFINITIONS = ${JSON.stringify(resultDefinitions)} as const;\n\n` +
    `export const JSON_RPC_ERROR_CODES = {\n` +
    `  PARSE_ERROR: ${rustNumber(protocolRust, 'PARSE_ERROR')},\n` +
    `  INVALID_REQUEST: ${rustNumber(protocolRust, 'INVALID_REQUEST')},\n` +
    `  METHOD_NOT_FOUND: ${rustNumber(protocolRust, 'METHOD_NOT_FOUND')},\n` +
    `  INVALID_PARAMS: ${rustNumber(protocolRust, 'INVALID_PARAMS')},\n` +
    `  INTERNAL_ERROR: ${rustNumber(protocolRust, 'INTERNAL_ERROR')},\n` +
    `  APPLICATION_ERROR: ${rustNumber(protocolRust, 'APPLICATION_ERROR')},\n` +
    `} as const;\n\n` +
    `export const DOMAIN_ERROR_CODES = ${JSON.stringify([
      rustString(watchRust, 'NOT_FOUND'),
      rustString(watchRust, 'GONE'),
      rustString(watchRust, 'SLOW_CONSUMER'),
      rustString(protocolRust, 'UNSUPPORTED_PROTOCOL_VERSION'),
      rustString(protocolRust, 'INTERNAL_ERROR_CODE'),
    ])} as const;\n\n` +
    aliases +
    '\n\n' +
    `export interface ClusterMethodParams {\n` +
    `  readonly initialize: InitializeParams; readonly plan: PlanParams; readonly apply: ApplyParams;\n` +
    `  readonly update: UpdateParams; readonly stop: StopParams; readonly retry: RetryParams;\n` +
    `  readonly resubmit: ResubmitParams; readonly delete: DeleteParams; readonly get: GetParams;\n` +
    `  readonly watch: WatchParams; readonly logs: LogsParams; readonly 'agent/attach': AgentAttachParams;\n` +
    `  readonly 'run/submit': RunSubmitParams; readonly 'run/list': RunListParams;\n` +
    `  readonly 'run/status': RunStatusParams; readonly 'run/watch': RunWatchParams;\n` +
    `  readonly 'run/logs': RunLogsParams; readonly 'run/attach': RunAttachParams;\n` +
    `  readonly 'run/force': RunForceParams;\n` +
    `}\n\n` +
    `export interface ClusterMethodResults {\n` +
    `  readonly initialize: InitializeResult; readonly plan: PlanResult; readonly apply: ApplyResult;\n` +
    `  readonly update: UpdateResult; readonly stop: StopResult; readonly retry: RetryResult;\n` +
    `  readonly resubmit: ResubmitResult; readonly delete: DeleteResult; readonly get: GetResult;\n` +
    `  readonly watch: WatchResult; readonly logs: LogsResult; readonly 'agent/attach': AgentAttachResult;\n` +
    `  readonly 'run/submit': RunSubmitResult; readonly 'run/list': RunListResult;\n` +
    `  readonly 'run/status': RunStatusResult; readonly 'run/watch': RunWatchResult;\n` +
    `  readonly 'run/logs': RunLogsResult; readonly 'run/attach': RunAttachResult;\n` +
    `  readonly 'run/force': RunForceResult;\n` +
    `}\n`
  );
}

const expected = generate();
const schemaExpected = renderSchemaModule(readJson(SCHEMA_PATH));
const check = process.argv.includes('--check');
const outputs = [
  [OUTPUT_PATH, expected],
  [SCHEMA_OUTPUT_PATH, schemaExpected],
];
if (check) {
  for (const [outputPath, outputExpected] of outputs) {
    const actual = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    if (actual !== outputExpected) {
      console.error(
        `Generated cluster protocol output is out of date: ${path.relative(ROOT, outputPath)}`
      );
      process.exitCode = 1;
    }
  }
} else {
  for (const [outputPath, outputExpected] of outputs) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, outputExpected);
  }
}
