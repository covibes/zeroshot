import contextMetrics = require('./context-metrics');
import contextPackBuilder = require('./context-pack-builder');
import agentContextPacks = require('./agent-context-packs');

import type { BuildContextParams, ContextStrategy } from './agent-context-types';

const MAX_CONTEXT_CHARS = 500000;
const { buildContextMetrics, emitContextMetrics, resolveLegacyMaxTokens, updateTotalMetrics } =
  contextMetrics;
const { buildContextPacks } = contextPackBuilder;
const { buildAgentContextPacks } = agentContextPacks;

function buildContext(params: BuildContextParams): string {
  const strategy: ContextStrategy = params.config.contextStrategy || { sources: [] };
  const continuation = params.mode === 'continuation';
  const packs = buildAgentContextPacks(params, strategy, continuation);
  const maxTokens = resolveLegacyMaxTokens(strategy);
  const packResult = buildContextPacks({
    packs,
    maxTokens,
    maxChars: MAX_CONTEXT_CHARS,
  });

  const metrics = buildContextMetrics({
    clusterId: params.cluster.id,
    agentId: params.id,
    role: params.role,
    iteration: params.iteration,
    triggeringMessage: params.triggeringMessage,
    strategy: {
      ...strategy,
      contextMode: continuation ? 'continuation' : 'full',
    },
    packs: packResult.packDecisions,
    budget: packResult.budget,
    truncation: packResult.truncation,
  });

  updateTotalMetrics(metrics, packResult.context.length);
  emitContextMetrics(metrics, {
    messageBus: params.messageBus,
    clusterId: params.cluster.id,
    agentId: params.id,
  });

  return packResult.context;
}

export = {
  buildContext,
};
