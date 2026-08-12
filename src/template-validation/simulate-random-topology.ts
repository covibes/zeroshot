import type { RandomTemplateConfig } from './random-topology-contracts';
import { runScenario } from './random-topology-scenario';
import { sampleFromSchema } from './random-topology-schema';

const DEFAULT_SAMPLES = 6;
const DEFAULT_MAX_STEPS = 120;
const DEFAULT_MAX_SCENARIO_MS = 120;
const MAX_ERRORS = 3;

interface SimulateRandomTopologyOptions {
  config: RandomTemplateConfig;
  templateId: string;
  templatesDir: string;
  samples?: number;
  maxSteps?: number;
  maxScenarioMs?: number;
}

async function simulateRandomTopology({
  config,
  templateId,
  templatesDir,
  samples = DEFAULT_SAMPLES,
  maxSteps = DEFAULT_MAX_STEPS,
  maxScenarioMs = DEFAULT_MAX_SCENARIO_MS,
}: SimulateRandomTopologyOptions): Promise<string[]> {
  const errors: string[] = [];
  if (!config?.agents || config.agents.length === 0) {
    return errors;
  }

  const baseSeed = 1337;
  const scenarioCount = Math.max(1, Number(samples) || DEFAULT_SAMPLES);
  for (let index = 0; index < scenarioCount; index += 1) {
    const seed = baseSeed + index * 9973;
    const outcome = await runScenario({
      config,
      templateId,
      seed,
      maxSteps,
      maxScenarioMs,
      templatesDir,
    });
    if (outcome.ok === true) continue;
    errors.push(
      `[RandomSim] ${templateId} seed=${seed}: ${outcome.reason}. ` +
        'Topology may be unsound under sampled schema-conformant outputs.'
    );
    if (errors.length >= MAX_ERRORS) break;
  }
  return errors;
}

export = {
  simulateRandomTopology,
  sampleFromSchema,
};
