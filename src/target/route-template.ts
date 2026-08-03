import { TargetDiscoveryError } from './discovery-errors.ts';

export interface RouteTemplate {
  readonly template: string;
  readonly variables: readonly string[];
  expand(values: Readonly<Record<string, string | number | undefined>>): string;
}

function expandCompiled(
  template: string,
  variables: readonly string[],
  values: Readonly<Record<string, string | number | undefined>>,
): string {
  const supplied = Object.keys(values).filter((key) => values[key] !== undefined);
  if (supplied.some((key) => !variables.includes(key))) {
    throw new TargetDiscoveryError('route expansion supplied an undeclared variable');
  }
  let expanded = template.replace(/\{\?([^}]+)\}/g, (_match, names: string) => {
    const params = names.split(',').flatMap((name) => {
      const value = values[name];
      return value === undefined
        ? []
        : [`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`];
    });
    return params.length === 0 ? '' : `?${params.join('&')}`;
  });
  expanded = expanded.replace(/\{([^}?][^}]*)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new TargetDiscoveryError(`route expansion is missing ${name}`);
    const opaque = String(value);
    if (opaque === '.' || opaque === '..') {
      throw new TargetDiscoveryError('route expansion contains a structural dot segment');
    }
    return encodeURIComponent(opaque);
  });
  if (/[{}]/.test(expanded)) {
    throw new TargetDiscoveryError('route expansion left an unexpanded variable');
  }
  const canonical = new URL(expanded, 'https://route-validation.invalid');
  if (canonical.origin !== 'https://route-validation.invalid' ||
      `${canonical.pathname}${canonical.search}` !== expanded) {
    throw new TargetDiscoveryError('route expansion changed during URL canonicalization');
  }
  return expanded;
}

function isUnsafeTemplate(value: unknown): boolean {
  return typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') ||
    value.includes('\\') || value.includes('#') || /[\u0000-\u0020\u007f]/.test(value) ||
    value.replace(/\{\?[^}]+\}/g, '').includes('?');
}

function expressionNames(
  expressions: RegExpMatchArray[],
  field: string,
): string[] {
  const found: string[] = [];
  for (const expression of expressions) {
    const body = expression[1];
    if (body === undefined) throw new TargetDiscoveryError(`${field} contains an invalid expression`);
    const query = body.startsWith('?');
    const names = body.replace(/^\?/, '').split(',');
    if (query && field !== 'capsule_protocol.route_templates.list') {
      throw new TargetDiscoveryError(`${field} contains an unsupported query expansion`);
    }
    found.push(...names);
  }
  return found;
}

export function routeTemplate(
  value: unknown,
  field: string,
  variables: readonly string[],
): RouteTemplate {
  if (isUnsafeTemplate(value)) {
    throw new TargetDiscoveryError(`${field} must be a safe relative route template`);
  }
  const template = value as string;
  const expressions = [...template.matchAll(/\{([^{}]+)\}/g)];
  const stripped = template.replace(/\{[^{}]+\}/g, '');
  if (stripped.includes('{') || stripped.includes('}') ||
      /(^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(stripped)) {
    throw new TargetDiscoveryError(`${field} contains an unsafe template expression`);
  }
  const found = expressionNames(expressions, field);
  if (found.length !== variables.length || new Set(found).size !== found.length ||
      variables.some((name) => !found.includes(name))) {
    throw new TargetDiscoveryError(`${field} declares unsupported variables`);
  }
  const compiledVariables = Object.freeze([...variables]);
  return Object.freeze({
    template,
    variables: compiledVariables,
    expand: (values: Readonly<Record<string, string | number | undefined>>) =>
      expandCompiled(template, compiledVariables, values),
  });
}

export function expandRoute(
  template: RouteTemplate,
  values: Readonly<Record<string, string | number | undefined>>,
): string {
  return template.expand(values);
}
