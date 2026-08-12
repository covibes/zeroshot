import contextSections = require('./agent-context-sections');
import contextSources = require('./agent-context-sources');
import qualityGatesContext = require('./agent-quality-gates-context');
import commandProofsContext = require('./agent-command-proofs-context');

import type {
  BuildContextParams,
  ContextMessageBus,
  ContextCluster,
  ContextStrategy,
} from './agent-context-types';
import type { ContextPack } from './context-pack-types';

interface StaticPackOptions {
  preserve?: boolean;
}

interface StaticPackParams {
  packs: ContextPack[];
  packId: string;
  section: string;
  text: string | null | undefined;
  order: number;
  options?: StaticPackOptions;
}

interface SourcePackContext {
  messageBus: ContextMessageBus;
  cluster: ContextCluster;
  lastTaskEndTime?: number | null | undefined;
  lastAgentStartTime?: number | null | undefined;
  afterId?: unknown;
  throughId?: unknown;
  triggeringMessageId?: unknown;
}

interface ContextPacksParams extends BuildContextParams {
  strategy: ContextStrategy;
}

interface StaticSections {
  header: string;
  instructions: string;
  repoTooling: string;
  commandProofs: string;
  legacyOutputSchema: string;
  queuedGuidance: string;
  requiredQualityGates: string;
  jsonSchema: string;
  validatorSkip: string;
  triggeringMessage: string;
}

const {
  buildHeaderContext,
  buildInstructionsSection,
  buildJsonSchemaSection,
  buildLegacyOutputSchemaSection,
  buildRepoToolingSection,
  buildTriggeringMessageSection,
  buildValidatorSkipSection,
} = contextSections;
const { buildSourcePack } = contextSources;
const { buildRequiredQualityGatesSection } = qualityGatesContext;
const { buildCommandProofsSection } = commandProofsContext;

function pushStaticPack({
  packs,
  packId,
  section,
  text,
  order,
  options = {},
}: StaticPackParams): number {
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

function appendSourcePacks(
  packs: ContextPack[],
  strategy: ContextStrategy,
  params: SourcePackContext,
  startingOrder: number
): number {
  if (!Array.isArray(strategy.sources)) {
    return startingOrder;
  }

  let order = startingOrder;
  strategy.sources.forEach((source, index) => {
    packs.push({
      ...buildSourcePack({ source, index, ...params }),
      order,
    });
    order += 1;
  });

  return order;
}

function buildStaticSections(params: BuildContextParams): StaticSections {
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
    instructions: buildInstructionsSection({
      config,
      selectedPrompt,
      id,
    }),
    repoTooling: buildRepoToolingSection({ config, worktree }),
    commandProofs: buildCommandProofsSection(config),
    legacyOutputSchema: buildLegacyOutputSchemaSection(config),
    queuedGuidance: queuedGuidance || '',
    requiredQualityGates: buildRequiredQualityGatesSection(config),
    jsonSchema: buildJsonSchemaSection(config),
    validatorSkip: buildValidatorSkipSection({
      role,
      messageBus,
      cluster,
      isolation,
    }),
    triggeringMessage: buildTriggeringMessageSection(triggeringMessage),
  };
}

function buildPacks(params: ContextPacksParams): ContextPack[] {
  const { strategy, messageBus, cluster, lastTaskEndTime, lastAgentStartTime, triggeringMessage } =
    params;
  const sections = buildStaticSections(params);
  const packs: ContextPack[] = [];
  let order = 0;
  const staticPackIds: (keyof StaticSections)[] = [
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
    order = pushStaticPack({
      packs,
      packId,
      section: packId,
      text: sections[packId],
      order,
    });
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

function buildContinuationPacks(params: ContextPacksParams): ContextPack[] {
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
  const packs: ContextPack[] = [];
  let order = 0;

  order = pushStaticPack({
    packs,
    packId: 'continuationHeader',
    section: 'continuationHeader',
    text:
      `## Continuation Turn\n\nAgent: ${id}\nIteration: ${iteration}\n\n` +
      'Apply only the new material below while retaining the existing session instructions.\n\n',
    order,
  });

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

function buildAgentContextPacks(
  params: BuildContextParams,
  strategy: ContextStrategy,
  continuation: boolean
): ContextPack[] {
  const contextPacksParams = { ...params, strategy };
  return continuation ? buildContinuationPacks(contextPacksParams) : buildPacks(contextPacksParams);
}

export = {
  buildAgentContextPacks,
};
