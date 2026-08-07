'use strict';

const { InvalidArgumentError } = require('commander');
const { isUuid } = require('./run-intent');

function positiveInteger(value) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new InvalidArgumentError('must be a positive integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError('is outside the safe integer range');
  }
  return parsed;
}

function canonicalUuid(value) {
  if (!isUuid(value)) throw new InvalidArgumentError('must be a canonical UUID');
  return value;
}

function commandNamed(program, name) {
  const command = program.commands.find((candidate) => candidate.name() === name);
  if (!command) throw new Error(`stable command ${name} is unavailable`);
  return command;
}

function invokedThroughAlias(command, alias) {
  return command.aliases().includes(alias) && command.parent?.args?.[0] === alias;
}

function explicitOptionNames(command) {
  return command.options
    .filter((option) => command.getOptionValueSource(option.attributeName()) === 'cli')
    .map((option) => option.attributeName());
}

function assertOnlyOptions(command, allowed) {
  const incompatible = explicitOptionNames(command).filter((name) => !allowed.has(name));
  if (incompatible.length > 0) {
    throw new Error(`hosted command does not accept local option --${incompatible[0]}`);
  }
}

async function failClosed(action) {
  try {
    return await action();
  } catch (error) {
    process.stderr.write(
      `Error: ${error instanceof Error ? error.message : 'hosted command failed'}\n`
    );
    process.exitCode = 1;
    return undefined;
  }
}

function wrapExisting(command, callback) {
  const original = command._actionHandler;
  if (typeof original !== 'function') {
    throw new Error(`stable command ${command.name()} has no action`);
  }
  command.action(function candidateDispatch(...args) {
    return callback({
      args,
      options: args.at(-2),
      command: args.at(-1),
      invokeLocal: () => original(command.processedArgs),
    });
  });
}

module.exports = {
  assertOnlyOptions,
  canonicalUuid,
  commandNamed,
  explicitOptionNames,
  failClosed,
  invokedThroughAlias,
  positiveInteger,
  wrapExisting,
};
