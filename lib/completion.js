const os = require('os');
const path = require('path');
const omelette = require('omelette');
const { readClustersFileSync } = require('./clusters-registry');

const CLUSTER_ID_COMMANDS = new Set([
  'attach',
  'export',
  'finish',
  'kill',
  'logs',
  'resume',
  'status',
  'stop',
]);

function commandNames(command) {
  return [command.name(), ...command.aliases()];
}

function visibleCommands(command) {
  return command.createHelp().visibleCommands(command);
}

function visibleOptions(command) {
  return command.createHelp().visibleOptions(command);
}

function optionNames(option) {
  return [option.short, option.long].filter(Boolean);
}

function findSubcommand(command, token) {
  return visibleCommands(command).find((candidate) => commandNames(candidate).includes(token));
}

function findOption(command, token) {
  const optionToken = token.split('=', 1)[0];
  return visibleOptions(command).find((option) => optionNames(option).includes(optionToken));
}

function parseCompletionLine(line) {
  const trailingSpace = /\s$/.test(line);
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  tokens.shift();
  const current = trailingSpace ? '' : (tokens.pop() ?? '');
  return { completed: tokens, current };
}

function resolveCommandContext(program, tokens) {
  let command = program;
  const pathParts = [];
  let expectsOptionValue = false;
  let sawPositional = false;

  for (const token of tokens) {
    if (expectsOptionValue) {
      expectsOptionValue = false;
      continue;
    }

    const option = findOption(command, token);
    if (option) {
      expectsOptionValue = !token.includes('=') && (option.required || option.optional);
      continue;
    }
    if (token.startsWith('-')) continue;

    const subcommand = sawPositional ? null : findSubcommand(command, token);
    if (subcommand) {
      command = subcommand;
      pathParts.push(subcommand.name());
      continue;
    }
    sawPositional = true;
  }

  return { command, commandPath: pathParts.join(' ') };
}

function defaultListClusterIds() {
  const homeDir =
    process.env.ZEROSHOT_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const registry = readClustersFileSync(path.join(homeDir, '.zeroshot'));
  return Object.keys(registry);
}

function safeDynamicIds(commandPath, listClusterIds) {
  if (!CLUSTER_ID_COMMANDS.has(commandPath)) return [];
  try {
    const ids = listClusterIds();
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id.length > 0) : [];
  } catch {
    return [];
  }
}

function getCompletionCandidates(program, line, deps = {}) {
  const { completed, current } = parseCompletionLine(line);
  const { command, commandPath } = resolveCommandContext(program, completed);
  const listClusterIds = deps.listClusterIds || defaultListClusterIds;
  const candidates = [
    ...visibleCommands(command).flatMap(commandNames),
    ...visibleOptions(command).flatMap(optionNames),
    ...safeDynamicIds(commandPath, listClusterIds),
  ];

  return [...new Set(candidates)].filter((candidate) => candidate.startsWith(current));
}

function setupCompletion(program, deps = {}) {
  const complete = omelette('zeroshot');
  complete.on('complete', (_fragment, data) => {
    data.reply(getCompletionCandidates(program, data.line, deps));
  });
  complete.init();
  return complete;
}

module.exports = {
  getCompletionCandidates,
  setupCompletion,
};
