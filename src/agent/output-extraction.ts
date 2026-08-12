import failureExtraction = require('./output-extraction-failures');
import jsonExtraction = require('./output-extraction-json');

const { MAX_CLI_ERROR_BYTES, extractClaudeVertexModelError, extractCliError, extractCliFailure } =
  failureExtraction;
const {
  extractDirectJson,
  extractFromMarkdown,
  extractFromResultWrapper,
  extractFromTextEvents,
  extractJsonFromOutput,
  extractModelTextFromOutput,
  hasFatalStandaloneOutput,
  stripTimestamp,
} = jsonExtraction;

export = {
  MAX_CLI_ERROR_BYTES,
  extractJsonFromOutput,
  extractModelTextFromOutput,
  extractCliFailure,
  extractCliError,
  extractClaudeVertexModelError,
  extractFromResultWrapper,
  extractFromTextEvents,
  extractFromMarkdown,
  extractDirectJson,
  stripTimestamp,
  hasFatalStandaloneOutput,
};
