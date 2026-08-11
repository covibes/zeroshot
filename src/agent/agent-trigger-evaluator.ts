/**
 * AgentTriggerEvaluator - Trigger matching and logic evaluation
 *
 * Provides:
 * - Trigger matching based on message topics
 * - Logic evaluation via LogicEngine
 * - Trigger action determination
 */

interface TriggerLogic {
  script?: string;
}

interface AgentTrigger {
  topic: string;
  logic?: TriggerLogic;
  action?: string;
}

interface TriggerMessage {
  topic: string;
  [key: string]: unknown;
}

interface AgentContext {
  [key: string]: unknown;
}

interface LogicEngine {
  evaluate(script: string, agent: AgentContext, message: TriggerMessage): boolean;
}

interface MatchingTriggerOptions {
  triggers?: readonly AgentTrigger[] | null;
  message: TriggerMessage;
}

interface EvaluateTriggerOptions {
  trigger: AgentTrigger;
  message: TriggerMessage;
  agent: AgentContext;
  logicEngine: LogicEngine;
}

/**
 * Find trigger matching the message topic.
 */
function findMatchingTrigger({
  triggers,
  message,
}: MatchingTriggerOptions): AgentTrigger | null | undefined {
  if (!triggers) {
    return null;
  }

  return triggers.find((trigger) => {
    // Match exact topic or wildcard
    if (trigger.topic === '*' || trigger.topic === message.topic) {
      return true;
    }
    // Match topic prefix (e.g., "VALIDATION_*")
    if (trigger.topic.endsWith('*')) {
      const prefix = trigger.topic.slice(0, -1);
      return message.topic.startsWith(prefix);
    }
    return false;
  });
}

/**
 * Evaluate trigger logic.
 */
function evaluateTrigger({
  trigger,
  message,
  agent,
  logicEngine,
}: EvaluateTriggerOptions): boolean {
  if (!trigger.logic || !trigger.logic.script) {
    return true; // No logic = always true
  }

  // NO TRY/CATCH - let errors propagate and crash
  return logicEngine.evaluate(trigger.logic.script, agent, message);
}

/**
 * Get trigger action type.
 */
function getTriggerAction(trigger: AgentTrigger): string {
  return trigger.action || 'execute_task';
}

export = {
  findMatchingTrigger,
  evaluateTrigger,
  getTriggerAction,
};
