'use strict';

const { createDefaultServices } = require('./default-services');
const { COMMAND_MANIFEST } = require('./manifest');
const {
  assertOnlyOptions,
  canonicalUuid,
  commandNamed,
  explicitOptionNames,
  failClosed,
  invokedThroughAlias,
  positiveInteger,
  wrapExisting,
} = require('./register-support');

function registerTarget(program, service) {
  const target = program.command('target').description('Manage named private hosted targets');
  target
    .command('add <name>')
    .description('Register a named remote target')
    .requiredOption('--url <url>', 'HTTPS origin')
    .action((name, options) => failClosed(() => service().targetAdd(name, options)));
  target
    .command('login <name>')
    .description('Authenticate through the target device flow')
    .action((name) => failClosed(() => service().targetLogin(name)));
  target
    .command('list')
    .description('List registered targets')
    .option('--json', 'Output JSON')
    .action((options) => failClosed(() => service().targetList(options)));
  target
    .command('remove <name>')
    .description('Revoke and remove a target')
    .option('--force', 'Remove even if remote revocation fails')
    .action((name, options) => failClosed(() => service().targetRemove(name, options)));
  target
    .command('setup <name>')
    .description('Bind a repository and local hosted runtime configuration')
    .requiredOption('--repository <owner/name>', 'Exact GitHub owner/name')
    .requiredOption('--base-revision <sha>', 'Exact lowercase 40-character commit')
    .requiredOption('--runtime-config <file>', 'Generic hosted runtime JSON')
    .action((name, options) => failClosed(() => service().targetSetup(name, options)));
  target
    .command('status <name> <intent-id>')
    .description('Inspect or follow a queued private hosted run')
    .option('--follow', 'Follow until the run reaches a terminal state')
    .option('--json', 'Output one current status as JSON')
    .action((name, intentId, options) =>
      failClosed(() => {
        canonicalUuid(intentId);
        if (options.follow && options.json) {
          throw new Error('--json cannot be combined with --follow');
        }
        return service().runIntentStatus(name, intentId, options);
      })
    );
  target
    .command('cancel <name> <intent-id>')
    .description('Request cancellation of a queued private hosted run')
    .action((name, intentId) =>
      failClosed(() => {
        canonicalUuid(intentId);
        return service().runIntentCancel(name, intentId);
      })
    );
  target.action(() => target.help());
}

function registerCapsule(program, service) {
  const capsule = program.command('capsule').description('Manage private hosted capsules');
  capsule
    .command('create')
    .requiredOption('--target <name>', 'Named target')
    .option('--label <label>', 'Capsule label')
    .option('--size <size>', 'Advertised capsule size')
    .action((options) =>
      failClosed(() => {
        if (
          options.label !== undefined &&
          (options.label.length < 1 || options.label.length > 100)
        ) {
          throw new Error('capsule label must be between 1 and 100 characters');
        }
        if (
          options.size !== undefined &&
          !['tiny', 'small', 'standard', 'large'].includes(options.size)
        ) {
          throw new Error('capsule size is not supported');
        }
        return service().capsuleCreate(options);
      })
    );
  capsule
    .command('terminate <capsule-id>')
    .requiredOption('--target <name>', 'Named target')
    .action((capsuleId, options) =>
      failClosed(() => service().capsuleTerminate(capsuleId, options))
    );
  capsule.action(() => capsule.help());
}

function registerHostedRun(program, service) {
  const run = commandNamed(program, 'run');
  const positional = run.registeredArguments[0];
  if (!positional) throw new Error('stable run argument is unavailable');
  positional.required = false;
  run
    .option('--graph <file>', 'Explicit hosted GraphSpec JSON')
    .option('--input <file>', 'Explicit hosted JSON input')
    .option('--target <name>', 'Named private hosted target')
    .option('--queue', 'Submit through the durable private RunIntent queue')
    .option('--submission-key <uuid>', 'Retry-stable RunIntent submission key', canonicalUuid);
  wrapExisting(run, ({ args, options, command, invokeLocal }) => {
    const inputArg = args[0];
    if (options.target === undefined) {
      if (
        options.graph !== undefined ||
        options.input !== undefined ||
        options.queue ||
        options.submissionKey !== undefined
      ) {
        return failClosed(() =>
          Promise.reject(
            new Error('--graph, --input, --queue, and --submission-key require --target')
          )
        );
      }
      if (inputArg === undefined) command.error("error: missing required argument 'input'");
      return invokeLocal();
    }
    return failClosed(() => {
      if (typeof options.target !== 'string' || options.target.length === 0) {
        throw new Error('--target must name a registered target');
      }
      assertOnlyOptions(
        command,
        new Set(['graph', 'input', 'target', 'detach', 'queue', 'submissionKey'])
      );
      if (inputArg !== undefined)
        throw new Error('general text/issue run is not available with --target');
      if (!options.graph || !options.input)
        throw new Error('hosted run requires both --graph and --input');
      if (options.submissionKey !== undefined && !options.queue) {
        throw new Error('--submission-key requires --queue');
      }
      return options.queue ? service().remoteQueueRun(options) : service().remoteRun(options);
    });
  });
}

function registerHostedList(program, service) {
  const list = commandNamed(program, 'list');
  list.option('--target <name>', 'Named private hosted target');
  wrapExisting(list, ({ options, command, invokeLocal }) => {
    if (options.target === undefined) return invokeLocal();
    return failClosed(() => {
      if (typeof options.target !== 'string' || options.target.length === 0) {
        throw new Error('--target must name a registered target');
      }
      if (invokedThroughAlias(command, 'ls')) {
        throw new Error('hosted list is available only as `list --target`');
      }
      assertOnlyOptions(command, new Set(['target', 'limit', 'json']));
      if (
        options.limit !== undefined &&
        (!Number.isSafeInteger(options.limit) || options.limit < 1)
      ) {
        throw new Error('--limit must be a positive integer');
      }
      return service().remoteList(options);
    });
  });
}

function registerHostedStatus(program, service) {
  const status = commandNamed(program, 'status');
  status.option('--target <name>', 'Named private hosted target');
  wrapExisting(status, ({ args, options, command, invokeLocal }) => {
    if (options.target === undefined) return invokeLocal();
    return failClosed(() => {
      if (typeof options.target !== 'string' || options.target.length === 0) {
        throw new Error('--target must name a registered target');
      }
      assertOnlyOptions(command, new Set(['target', 'json']));
      return service().remoteStatus(args[0], options);
    });
  });
}

function registerHostedStop(program, service) {
  const stop = commandNamed(program, 'stop');
  stop
    .option('--target <name>', 'Named private hosted target')
    .option('--force', 'Force OECP stop instead of drain');
  wrapExisting(stop, ({ args, options, command, invokeLocal }) => {
    if (options.target === undefined) {
      if (options.force)
        return failClosed(() => Promise.reject(new Error('--force requires --target')));
      return invokeLocal();
    }
    return failClosed(() => {
      if (typeof options.target !== 'string' || options.target.length === 0) {
        throw new Error('--target must name a registered target');
      }
      assertOnlyOptions(command, new Set(['target', 'force']));
      return service().remoteStop(args[0], options);
    });
  });
}

function registerPrivateHostedCandidate(program, dependencies) {
  if (!program || typeof program.command !== 'function')
    throw new TypeError('Commander program is required');
  if (
    typeof dependencies?.loadSettings !== 'function' ||
    typeof dependencies?.mutateSettings !== 'function'
  ) {
    throw new TypeError('stable settings accessors are required');
  }
  let loaded;
  const service = () => {
    loaded ??= dependencies.services ?? createDefaultServices(dependencies);
    return loaded;
  };
  registerTarget(program, service);
  registerCapsule(program, service);
  registerHostedRun(program, service);
  registerHostedList(program, service);
  registerHostedStatus(program, service);
  registerHostedStop(program, service);
  Object.defineProperty(program, 'privateHostedCommandManifest', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: COMMAND_MANIFEST,
  });
}

module.exports = {
  assertOnlyOptions,
  explicitOptionNames,
  positiveInteger,
  registerPrivateHostedCandidate,
};
