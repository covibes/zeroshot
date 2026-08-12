import environmentSections = require('./agent-context-environment-sections');
import promptSections = require('./agent-context-prompt-sections');
import validationSections = require('./agent-context-validation-sections');

import type { TriggeringMessage } from './agent-context-types';

const { buildHeaderContext, buildRepoToolingSection } = environmentSections;
const { buildInstructionsSection, buildJsonSchemaSection, buildLegacyOutputSchemaSection } =
  promptSections;
const { buildValidatorSkipSection } = validationSections;

function buildTriggeringMessageSection(triggeringMessage: TriggeringMessage): string {
  const lines = [
    '',
    '## Triggering Message',
    '',
    `Topic: ${triggeringMessage.topic}`,
    `Sender: ${triggeringMessage.sender}`,
  ];

  if (triggeringMessage.content?.text) {
    lines.push('', triggeringMessage.content.text);
  }

  return `${lines.join('\n')}\n`;
}

export = {
  buildHeaderContext,
  buildInstructionsSection,
  buildJsonSchemaSection,
  buildLegacyOutputSchemaSection,
  buildRepoToolingSection,
  buildTriggeringMessageSection,
  buildValidatorSkipSection,
};
