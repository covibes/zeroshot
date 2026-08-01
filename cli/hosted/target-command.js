'use strict';

const { login } = require('./auth');
const { removeRefreshToken } = require('./credential-store');
const { addTarget, getTarget, loadTargets, removeTarget } = require('./target-store');

function registerTargetCommands(program) {
  const target = program.command('target').description('Manage named Zero Cloud targets');
  target
    .command('add <name> <endpoint>')
    .description('Add or update a Zero Cloud endpoint')
    .action((name, endpoint) => {
      const saved = addTarget(name, endpoint);
      console.log(`${name}\t${saved.endpoint}`);
    });
  target
    .command('list')
    .description('List configured Zero Cloud targets')
    .action(() => {
      const entries = Object.entries(loadTargets().targets).sort(([left], [right]) =>
        left.localeCompare(right)
      );
      for (const [name, configured] of entries) console.log(`${name}\t${configured.endpoint}`);
    });
  target
    .command('login <name>')
    .description('Authorize this CLI using the device flow')
    .action(async (name) => {
      await login(name, getTarget(name));
      console.log(`Logged in to ${name}`);
    });
  target
    .command('remove <name>')
    .description('Remove a target and its stored login')
    .action((name) => {
      removeTarget(name);
      removeRefreshToken(name);
      console.log(`Removed ${name}`);
    });
}

module.exports = { registerTargetCommands };
