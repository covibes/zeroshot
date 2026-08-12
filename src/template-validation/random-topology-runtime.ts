interface TemplateResolverInstance {
  resolveConfigReference(configOperation: unknown): unknown;
}

interface TemplateResolverConstructor {
  new (templatesDirectory: string): TemplateResolverInstance;
}

interface TriggerEvaluatorModule {
  findMatchingTrigger(options: unknown): unknown;
  evaluateTrigger(options: unknown): boolean;
}

function isTemplateResolverConstructor(value: unknown): value is TemplateResolverConstructor {
  return typeof value === 'function';
}

function isTriggerEvaluatorModule(value: unknown): value is TriggerEvaluatorModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'findMatchingTrigger' in value &&
    typeof value.findMatchingTrigger === 'function' &&
    'evaluateTrigger' in value &&
    typeof value.evaluateTrigger === 'function'
  );
}

const templateResolverModule: unknown = require('../template-resolver');
const triggerEvaluatorModule: unknown = require('../agent/agent-trigger-evaluator');

if (!isTemplateResolverConstructor(templateResolverModule)) {
  throw new TypeError('template-resolver must export a constructor');
}
if (!isTriggerEvaluatorModule(triggerEvaluatorModule)) {
  throw new TypeError('agent-trigger-evaluator must export trigger functions');
}

export = {
  TemplateResolver: templateResolverModule,
  findMatchingTrigger: triggerEvaluatorModule.findMatchingTrigger,
  evaluateTrigger: triggerEvaluatorModule.evaluateTrigger,
};
