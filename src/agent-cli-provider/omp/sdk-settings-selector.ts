import { invalidField } from '../contract-errors';
import { MODEL_COMPONENT, PROVIDER_ID } from './sdk-settings-constants';
import type { ExactOmpModelSelector } from './sdk-settings-types';

export function parseExactOmpModelSelector(selector: unknown): ExactOmpModelSelector {
  if (typeof selector !== 'string' || selector.length === 0 || selector !== selector.trim()) {
    invalidField(
      'modelSelector',
      'OMP model selectors must be non-empty strings without surrounding whitespace.'
    );
  }
  const separator = selector.indexOf('/');
  const provider = separator === -1 ? '' : selector.slice(0, separator);
  const model = separator === -1 ? '' : selector.slice(separator + 1);
  if (
    !PROVIDER_ID.test(provider) ||
    !MODEL_COMPONENT.test(model) ||
    model.length === 0 ||
    model.includes(',') ||
    model.startsWith('@')
  ) {
    invalidField(
      'modelSelector',
      'OMP model selectors must be exact full provider/model selectors with no fallback chain or alias.'
    );
  }
  return { provider, model };
}
