import type { RouteTemplate } from './route-template.js';
import { routeTemplate } from './route-template.js';
import { closedRecord, record, sameOriginUrl } from './discovery-validation.js';

export interface RunIntentDescriptor {
  readonly kind: 'zeroshot.run-intent/v2';
  readonly baseUrl: string;
  readonly routes: {
    readonly submit: RouteTemplate;
    readonly status: RouteTemplate;
    readonly cancel: RouteTemplate;
  };
}

export function parseRunIntent(value: unknown, origin: string): RunIntentDescriptor | null {
  if (value === undefined || value === null) return null;
  const advertised = record(value, 'extensions.run_intent');
  if (advertised.kind !== 'zeroshot.run-intent/v2') return null;
  const extension = closedRecord(value, 'extensions.run_intent', [
    'kind',
    'base_url',
    'route_templates',
  ]);
  const routes = closedRecord(extension.route_templates, 'extensions.run_intent.route_templates', [
    'submit',
    'status',
    'cancel',
  ]);
  const route = (name: string, variables: readonly string[]) =>
    routeTemplate(routes[name], `extensions.run_intent.route_templates.${name}`, variables);
  return Object.freeze({
    kind: 'zeroshot.run-intent/v2' as const,
    baseUrl: sameOriginUrl(extension.base_url, 'extensions.run_intent.base_url', origin),
    routes: Object.freeze({
      submit: route('submit', ['org_id']),
      status: route('status', ['org_id', 'intent_id']),
      cancel: route('cancel', ['org_id', 'intent_id']),
    }),
  });
}
