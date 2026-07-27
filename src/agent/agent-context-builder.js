/**
 * AgentContextBuilder - Build agent execution context from ledger
 *
 * Provides:
 * - Context assembly from multiple message sources
 * - Context strategy evaluation (topics, limits, since timestamps)
 * - Prompt injection and formatting
 * - Token-budgeted context packs
 * - Defensive context overflow prevention
 */

// Defensive limit: 500,000 chars ≈ 125k tokens (safe buffer below 200k limit)
// Prevents "Prompt is too long" errors that kill tasks
const MAX_CONTEXT_CHARS = 500000;
const {
  buildContextMetrics,
  emitContextMetrics,
  resolveLegacyMaxTokens,
  updateTotalMetrics,
} = require('./context-metrics');
const { buildContextPacks } = require('./context-pack-builder');
const { buildSourcePack } = require('./agent-context-sources');
const {
  buildHeaderContext,
  buildInstructionsSection,
  buildJsonSchemaSection,
  buildLegacyOutputSchemaSection,
  buildRepoToolingSection,
  buildTriggeringMessageSection,
  buildValidatorSkipSection,
} = require('./agent-context-sections');
const { buildRequiredQualityGatesSection } = require('./agent-quality-gates-context');
const { buildCommandProofsSection } = require('./agent-command-proofs-context');

function pushStaticPack({ packs, packId, section, text, order, options = {} }) {
  if (!text) {
    return order;
  }

  packs.push({
    id: packId,
    section,
    priority: 'required',
    order,
    preserve: options.preserve || false,
    render: () => text,
  });

  return order + 1;
}

function appendSourcePacks(packs, strategy, params, startingOrder) {
  if (!Array.isArray(strategy.sources)) {
    return startingOrder;
  }

  let order = startingOrder;
  strategy.sources.forEach((source, index) => {
    packs.push({ ...buildSourcePack({ source, index, ...params }), order });
    order += 1;
  });

  return order;
}

function buildStaticSections(params) {
  const {
    id,
    role,
    iteration,
    config,
    selectedPrompt,
    queuedGuidance,
    messageBus,
    cluster,
    triggeringMessage,
    worktree,
    isolation,
  } = params;
  const isIsolated = !!(worktree?.enabled || isolation?.enabled);

  return {
    header: buildHeaderContext({ id, role, iteration, isIsolated }),
    instructions: buildInstructionsSection({ config, selectedPrompt, id }),
    repoTooling: buildRepoToolingSection({ config, worktree }),
    commandProofs: buildCommandProofsSection(config),
    legacyOutputSchema: buildLegacyOutputSchemaSection(config),
    queuedGuidance: queuedGuidance || '',
    requiredQualityGates: buildRequiredQualityGatesSection(config),
    jsonSchema: buildJsonSchemaSection(config),
    validatorSkip: buildValidatorSkipSection({ role, messageBus, cluster, isolation }),
    triggeringMessage: buildTriggeringMessageSection(triggeringMessage),
  };
}

function buildPacks(params) {
  const { strategy, messageBus, cluster, lastTaskEndTime, lastAgentStartTime, triggeringMessage } =
    params;
  const sections = buildStaticSections(params);
  const packs = [];
  let order = 0;
  const staticPackIds = [
    'header',
    'instructions',
    'repoTooling',
    'commandProofs',
    'queuedGuidance',
    'legacyOutputSchema',
    'requiredQualityGates',
    'jsonSchema',
  ];

  for (const packId of staticPackIds) {
    order = pushStaticPack({ packs, packId, section: packId, text: sections[packId], order });
  }

  order = appendSourcePacks(
    packs,
    strategy,
    {
      messageBus,
      cluster,
      lastTaskEndTime,
      lastAgentStartTime,
      throughId: params.contextThroughId,
      triggeringMessageId: triggeringMessage?.id,
    },
    order
  );
  order = pushStaticPack({
    packs,
    packId: 'validatorSkip',
    section: 'validatorSkip',
    text: sections.validatorSkip,
    order,
  });
  pushStaticPack({
    packs,
    packId: 'triggeringMessage',
    section: 'triggeringMessage',
    text: sections.triggeringMessage,
    order,
    options: { preserve: true },
  });

  return packs;
}

function buildContinuationPacks(params) {
  const {
    id,
    iteration,
    config,
    selectedPrompt,
    queuedGuidance,
    triggeringMessage,
    strategy,
    messageBus,
    cluster,
    lastTaskEndTime,
    lastAgentStartTime,
    continuationSequence,
    contextThroughId,
    previousPromptIdentity,
    currentPromptIdentity,
  } = params;
  const packs = [];
  let order = 0;

  order = pushStaticPack({
    packs,
    packId: 'continuationHeader',
    section: 'continuationHeader',
    text: `## Continuation Turn\n\nAgent: ${id}\nIteration: ${iteration}\n\nApply only the new material below while retaining the existing session instructions.\n\n`,
    order,
  });

  // Iteration-rule prompts may intentionally change between turns. Static prompts,
  // repository tooling, ISSUE_OPENED/PLAN_READY sources, and output contracts are
  // already present in the provider session and must not be replayed.
  if (config.promptConfig?.type === 'rules' && currentPromptIdentity !== previousPromptIdentity) {
    order = pushStaticPack({
      packs,
      packId: 'iterationInstructions',
      section: 'iterationInstructions',
      text: buildInstructionsSection({ config, selectedPrompt, id }),
      order,
    });
  }

  order = pushStaticPack({
    packs,
    packId: 'queuedGuidance',
    section: 'queuedGuidance',
    text: queuedGuidance || '',
    order,
  });
  order = appendSourcePacks(
    packs,
    strategy,
    {
      messageBus,
      cluster,
      lastTaskEndTime,
      lastAgentStartTime,
      afterId: continuationSequence,
      throughId: contextThroughId,
      triggeringMessageId: triggeringMessage?.id,
    },
    order
  );
  pushStaticPack({
    packs,
    packId: 'triggeringMessage',
    section: 'triggeringMessage',
    text: buildTriggeringMessageSection(triggeringMessage),
    order,
    options: { preserve: true },
  });

  return packs;
}

/**
 * Build execution context for an agent
 * @param {object} params - Context building parameters
 * @param {string} params.id - Agent ID
 * @param {string} params.role - Agent role
 * @param {number} params.iteration - Current iteration number
 * @param {any} params.config - Agent configuration
 * @param {any} params.messageBus - Message bus for querying ledger
 * @param {any} params.cluster - Cluster object
 * @param {number} [params.lastTaskEndTime] - Timestamp of last task completion
 * @param {number} [params.lastAgentStartTime] - Timestamp when this agent last started work
 * @param {any} params.triggeringMessage - Message that triggered this execution
 * @param {string} [params.selectedPrompt] - Pre-selected prompt from _selectPrompt() (iteration-based)
 * @param {object} [params.worktree] - Worktree isolation state (if running in worktree mode)
 * @param {object} [params.isolation] - Docker isolation state (if running in Docker mode)
 * @returns {string} Assembled context string
 */
function buildContext(params) {
  const strategy = params.config.contextStrategy || { sources: [] };
  const continuation = params.mode === 'continuation';
  const packs = continuation
    ? buildContinuationPacks({ ...params, strategy })
    : buildPacks({ ...params, strategy });
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
    strategy: { ...strategy, contextMode: continuation ? 'continuation' : 'full' },
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

module.exports = {
  buildContext,
};
