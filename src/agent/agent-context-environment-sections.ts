import fs = require('fs');
import path = require('path');

import type { AgentContextConfig, WorktreeContext } from './agent-context-types';

interface HeaderContextParams {
  id: string;
  role: string;
  iteration: number;
  isIsolated: boolean;
}

interface RepoToolingParams {
  config?: AgentContextConfig | null | undefined;
  worktree?: WorktreeContext | null | undefined;
}

const { readFileSync } = fs;
const { join, resolve } = path;

function buildAutonomousSection(): string {
  return [
    '## 🔴 CRITICAL: AUTONOMOUS EXECUTION REQUIRED',
    '',
    'You are running in a NON-INTERACTIVE cluster environment.',
    '',
    '**NEVER** use AskUserQuestion or ask for user input - there is NO user to respond.',
    '**NEVER** ask "Would you like me to..." or "Should I..." - JUST DO IT.',
    '**NEVER** wait for approval or confirmation - MAKE DECISIONS AUTONOMOUSLY.',
    '',
    'When facing choices:',
    '- Choose the option that maintains code quality and correctness',
    '- If unsure between "fix the code" vs "relax the rules" → ALWAYS fix the code',
    '- If unsure between "do more" vs "do less" → ALWAYS do what\'s required, nothing more',
    '',
  ].join('\n');
}

function buildOutputStyleSection(): string {
  return [
    '## 🔴 OUTPUT STYLE - NON-NEGOTIABLE',
    '',
    '**ALL OUTPUT: Maximum informativeness, minimum verbosity. NO EXCEPTIONS.**',
    '',
    'This applies to EVERYTHING you output:',
    '- Text responses',
    '- JSON schema values',
    '- Reasoning fields',
    '- Summary fields',
    '- ALL string values in structured output',
    '',
    'Rules:',
    '- Progress: "Reading auth.ts" NOT "I will now read the auth.ts file..."',
    '- Tool calls: NO preamble. Call immediately.',
    '- Schema strings: Dense facts. No filler. No fluff.',
    '- Errors: DETAILED (stack traces, repro). NEVER compress errors.',
    '- FORBIDDEN: "I\'ll help...", "Let me...", "I\'m going to...", "Sure!", "Great!", "Certainly!"',
    '',
    'Every token costs money. Waste nothing.',
    '',
  ].join('\n');
}

function buildGitOperationsSection(): string {
  return [
    '## 🚫 GIT OPERATIONS - FORBIDDEN',
    '',
    'NEVER commit, push, or create PRs. You only modify files.',
    'The git-pusher agent handles ALL git operations AFTER validators approve.',
    '',
    '- ❌ NEVER run: git add, git commit, git push, gh pr create',
    '- ❌ NEVER suggest committing changes',
    '- ✅ Only modify files and publish your completion message when done',
    '',
  ].join('\n');
}

function buildHeaderContext({ id, role, iteration, isIsolated }: HeaderContextParams): string {
  return [
    `You are agent "${id}" with role "${role}".`,
    '',
    `Iteration: ${iteration}`,
    '',
    buildAutonomousSection(),
    buildOutputStyleSection(),
    isIsolated ? '' : buildGitOperationsSection(),
  ]
    .filter(Boolean)
    .join('\n');
}

function hasIgnoredRepoToolingError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)
  );
}

function resolveRepoToolingRoots({ config, worktree }: RepoToolingParams): string[] {
  return Array.from(
    new Set(
      [worktree?.path, config?.cwd, process.cwd()]
        .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
        .map((value) => resolve(value))
    )
  );
}

function buildRepoToolingSection({ config, worktree }: RepoToolingParams): string {
  for (const root of resolveRepoToolingRoots({ config, worktree })) {
    const skillPath = join(root, '.claude', 'skills', 'repo-tooling', 'SKILL.md');

    try {
      const content = readFileSync(skillPath, 'utf8').trim();
      if (content !== '') {
        return `${content}\n\n`;
      }
    } catch (error) {
      if (!hasIgnoredRepoToolingError(error)) {
        throw error;
      }
    }
  }

  return '';
}

export = {
  buildHeaderContext,
  buildRepoToolingSection,
};
