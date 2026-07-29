import { getTaskBySpawnOwnershipToken } from '../store.js';

export function getTaskIdBySpawnToken(token) {
  const task = getTaskBySpawnOwnershipToken(token);
  if (!task) {
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${task.id}\n`);
}
