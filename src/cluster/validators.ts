import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import {
  METHOD_RESULT_DEFINITIONS,
  PROTOCOL_VERSION,
} from './generated/protocol.js';
import type { ClusterMethod, GraphProfile, GraphSpec, ServerCapabilities } from './generated/protocol.js';
import { CLUSTER_PROTOCOL_SCHEMA } from './generated/protocol-schema.js';
import { ClusterProtocolError, ClusterRequestError } from './errors.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
ajv.addSchema(CLUSTER_PROTOCOL_SCHEMA as object, 'openengine-cluster-v1');
const validators = new Map<string, ValidateFunction>();

function validatorFor(definition: string): ValidateFunction {
  const cached = validators.get(definition);
  if (cached) return cached;
  const validator = ajv.compile({
    $ref: `openengine-cluster-v1#/$defs/${definition}`,
  });
  validators.set(definition, validator);
  return validator;
}

export function assertDefinition(definition: string, value: unknown): void {
  const validate = validatorFor(definition);
  if (validate(value)) return;
  const details = (validate.errors ?? []).map((error) =>
    `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`
  ).join('; ');
  throw new ClusterProtocolError(
    `${definition} validation failed: ${details}`,
    'INVALID_RESPONSE',
  );
}

export function assertMethodResult(method: ClusterMethod, value: unknown): void {
  try {
    assertDefinition(METHOD_RESULT_DEFINITIONS[method], value);
  } catch (error) {
    const receivedVersion = method === 'initialize' && value !== null && typeof value === 'object'
      ? (value as Readonly<Record<string, unknown>>).protocolVersion
      : undefined;
    if (typeof receivedVersion === 'string' && receivedVersion !== PROTOCOL_VERSION) {
      throw new ClusterProtocolError(
        `unsupported protocol version ${receivedVersion}`,
        'UNSUPPORTED_PROTOCOL_VERSION',
      );
    }
    throw error;
  }
}

function assertRequestDefinition(definition: string, value: unknown, code: string): void {
  const validate = validatorFor(definition);
  if (validate(value)) return;
  const details = (validate.errors ?? []).map((error) =>
    `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`
  ).join('; ');
  throw new ClusterRequestError(`${definition} validation failed: ${details}`, code);
}

/** Validate an execution graph against the frozen cluster protocol schema. */
export function assertGraphSpec(value: unknown): asserts value is GraphSpec {
  assertRequestDefinition('GraphSpec', value, 'INVALID_GRAPH');
}

export function assertGraphProfile(value: unknown): asserts value is GraphProfile {
  assertRequestDefinition('GraphProfile', value, 'INVALID_GRAPH_PROFILE');
}

export function assertGraphProfileSupported(
  profile: GraphProfile,
  capabilities: ServerCapabilities,
): void {
  if (!capabilities.graphProfiles?.includes(profile)) {
    throw new ClusterRequestError(
      `graph profile ${profile} is not among the server's advertised graphProfiles`,
      'UNSUPPORTED_GRAPH_PROFILE',
    );
  }
}
