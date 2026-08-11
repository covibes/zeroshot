import { join } from 'path';
import { homedir } from 'os';

const HOME_DIR: string =
  process.env.ZEROSHOT_HOME || process.env.HOME || process.env.USERPROFILE || homedir();

export const TASKS_DIR = join(HOME_DIR, '.claude-zeroshot');
export const LOGS_DIR = join(TASKS_DIR, 'logs');
export const SCHEDULER_PID_FILE = join(TASKS_DIR, 'scheduler.pid');
export const SCHEDULER_LOG = join(TASKS_DIR, 'scheduler.log');
export const DEFAULT_MODEL = 'sonnet';
