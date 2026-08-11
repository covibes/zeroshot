import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const { execSync, spawnSync } = childProcess;

function commandExists(command: string): boolean {
  if (!command) return false;
  if (command.includes(path.sep)) {
    return fs.existsSync(command);
  }
  const probe = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`;
  try {
    execSync(probe, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getCommandPath(command: string): string | null {
  if (!command) return null;
  if (command.includes(path.sep)) {
    return fs.existsSync(command) ? command : null;
  }
  const probe = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`;
  try {
    const output = execSync(probe, { encoding: 'utf8', stdio: 'pipe' });
    // `where` can return multiple matches (one per line); take the first.
    const [firstMatch = ''] = output.split(/\r?\n/);
    return firstMatch.trim() || null;
  } catch {
    return null;
  }
}

function getHelpOutput(command: string, args: string[] = []): string {
  if (!commandExists(command)) return '';

  const attempt = (flag: string): string => {
    const result = spawnSync(command, [...args, flag], { encoding: 'utf8' });
    if (result.status !== 0) return '';
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    return output.trim();
  };

  const help = attempt('--help');
  if (help) return help;

  const alt = attempt('-h');
  return alt || '';
}

function getVersionOutput(command: string, args: string[] = []): string {
  if (!commandExists(command)) return '';
  const result = spawnSync(command, [...args, '--version'], { encoding: 'utf8' });
  if (result.status !== 0) return '';
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return output.trim();
}

export = {
  commandExists,
  getCommandPath,
  getHelpOutput,
  getVersionOutput,
};
