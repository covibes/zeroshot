const assert = require('node:assert').strict;
const { execFileSync: runFile } = require('node:child_process');
const filesystem = require('node:fs');
const { tmpdir } = require('node:os');
const nodePath = require('node:path');

const { buildCompletionPrompt, buildDefaultFinishPrBody } = require('../cli/index');
const { getPlatformConfig, resolveGitHubConfig } = require('../src/agents/git-pusher-template');
const Orchestrator = require('../src/orchestrator');

function installArgumentRecorder(binDir, command, rowMode = false) {
  const executable = nodePath.join(binDir, command);
  const body = rowMode
    ? `const fs = require('node:fs');
const rows = fs.existsSync(process.env.ZEROSHOT_ARGUMENT_LOG)
  ? JSON.parse(fs.readFileSync(process.env.ZEROSHOT_ARGUMENT_LOG, 'utf8'))
  : [];
rows.push([${JSON.stringify(command)}, ...process.argv.slice(2)]);
fs.writeFileSync(process.env.ZEROSHOT_ARGUMENT_LOG, JSON.stringify(rows));`
    : "require('node:fs').writeFileSync(process.env.ZEROSHOT_ARGUMENT_LOG, JSON.stringify(process.argv.slice(2)));";
  filesystem.writeFileSync(executable, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  filesystem.chmodSync(executable, 0o755);
}

function commandStartingWith(prompt, prefix) {
  return prompt
    .split('\n')
    .map((line) => line.trimStart())
    .find((line) => line.startsWith(prefix));
}

function prCreateCommand(prompt) {
  const marker = '   gh pr create ';
  const start = prompt.indexOf(marker);
  assert.notStrictEqual(start, -1, 'PR creation command missing');
  const end = prompt.indexOf('\n   ```', start);
  assert.notStrictEqual(end, -1, 'PR creation command fence missing');
  return prompt.slice(start, end).trimStart();
}

describe('git-pusher PR body command quoting', function () {
  it('preserves a custom body as one literal argument', function () {
    if (process.platform === 'win32') this.skip();

    const cwd = filesystem.mkdtempSync(nodePath.join(tmpdir(), 'zeroshot-pr-body-'));
    const binDir = nodePath.join(cwd, 'bin');
    const argumentLog = nodePath.join(cwd, 'arguments.json');
    const injectedFile = nodePath.join(cwd, 'PWNED');
    const template = [
      '## Summary',
      "literal ' quote",
      `$(touch ${injectedFile})`,
      `\`touch ${injectedFile}\``,
      '{{issue_title}}',
      '{{issue_reference}}',
    ].join('\n');
    const expected = template
      .replaceAll('{{issue_title}}', "Handle the user's input")
      .replaceAll('{{issue_reference}}', 'Closes #448');

    try {
      filesystem.mkdirSync(binDir);
      installArgumentRecorder(binDir, 'gh');
      const resolved = resolveGitHubConfig({
        cwd,
        prBody: template,
        issueNumber: 448,
        issueTitle: "Handle the user's input",
      });
      runFile('/bin/sh', ['-c', getPlatformConfig('github', resolved).createCmd], {
        cwd,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          ZEROSHOT_ARGUMENT_LOG: argumentLog,
        },
      });

      const args = JSON.parse(filesystem.readFileSync(argumentLog, 'utf8'));
      assert.strictEqual(args[args.indexOf('--body') + 1], expected);
      assert.strictEqual(filesystem.existsSync(injectedFile), false);
    } finally {
      filesystem.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('PR body persistence across completion-agent injection', function () {
  it('builds the same custom body for a fresh run and a resumed run', async function () {
    const cwd = filesystem.mkdtempSync(nodePath.join(tmpdir(), 'zeroshot-pr-body-resume-'));
    runFile('git', ['init'], { cwd, stdio: 'ignore' });
    runFile('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], {
      cwd,
      stdio: 'ignore',
    });
    const orchestrator = new Orchestrator({
      quiet: true,
      skipLoad: true,
      storageDir: nodePath.join(cwd, 'storage'),
    });
    const prBody = '## Issue {{issue_number}}\n\n{{issue_title}}\n\n{{issue_reference}}';
    const inputData = { number: 448, title: 'Resume-safe body' };

    try {
      const freshConfig = { agents: [{ id: 'completion-detector' }] };
      orchestrator._applyAutoPrConfig(freshConfig, inputData, {
        autoPr: true,
        autoMerge: false,
        cwd,
        prBody,
        requiredQualityGates: [],
      });
      const freshAgent = freshConfig.agents.find((agent) => agent.id === 'git-pusher');

      let resumedAgent = null;
      orchestrator._opAddAgents = (_cluster, operation) => {
        resumedAgent = operation.agents[0];
      };
      await orchestrator._injectCompletionAgent(
        {
          agents: [],
          autoPr: true,
          cwd,
          gitPlatform: 'github',
          prOptions: Orchestrator.buildPrOptions({ pr: true, autoMerge: false, cwd, prBody }, []),
          messageBus: {
            ledger: {
              findLast: () => ({
                content: { data: { issue_number: inputData.number, title: inputData.title } },
              }),
            },
          },
        },
        {}
      );

      assert.ok(freshAgent);
      assert.ok(resumedAgent);
      assert.strictEqual(resumedAgent.prompt, freshAgent.prompt);
      assert.match(resumedAgent.prompt, /## Issue 448/);
      assert.match(resumedAgent.prompt, /Closes #448/);
    } finally {
      orchestrator.close();
      filesystem.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('zeroshot finish PR body assembly', function () {
  it('omits invalid issue references and shell-quotes hostile values', function () {
    if (process.platform === 'win32') this.skip();

    const cwd = filesystem.mkdtempSync(nodePath.join(tmpdir(), 'zeroshot-finish-body-'));
    const binDir = nodePath.join(cwd, 'bin');
    const argumentLog = nodePath.join(cwd, 'arguments.json');
    const injectedFile = nodePath.join(cwd, 'PWNED');
    const issueTitle = `fix: safe'; touch ${injectedFile}; echo '`;
    const taskText = `Do the work; $(touch ${injectedFile})`;
    const bodyTemplate = [
      '## Review',
      `$(touch ${injectedFile})`,
      '{{issue_title}}',
      '{{issue_reference}}',
    ].join('\n');
    const expectedBody = bodyTemplate
      .replaceAll('{{issue_title}}', issueTitle)
      .replaceAll('{{issue_reference}}', 'Closes #1011');

    try {
      filesystem.mkdirSync(binDir);
      installArgumentRecorder(binDir, 'git', true);
      installArgumentRecorder(binDir, 'gh', true);
      const prompt = buildCompletionPrompt({
        contextSummary: taskText,
        taskText,
        issueNumber: 1011,
        issueTitle,
        prBody: bodyTemplate,
      });
      const commands = [
        commandStartingWith(prompt, 'git commit -m '),
        commandStartingWith(prompt, 'git checkout -b '),
        prCreateCommand(prompt),
      ];
      assert.ok(commands.every(Boolean));
      for (const command of commands) {
        runFile('/bin/sh', ['-c', command], {
          cwd,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            ZEROSHOT_ARGUMENT_LOG: argumentLog,
          },
        });
      }

      const rows = JSON.parse(filesystem.readFileSync(argumentLog, 'utf8'));
      const commitArgs = rows.find(
        ([command, subcommand]) => command === 'git' && subcommand === 'commit'
      );
      const prArgs = rows.find(([command]) => command === 'gh');
      assert.ok(commitArgs.includes(issueTitle));
      assert.strictEqual(prArgs[prArgs.indexOf('--body') + 1], expectedBody);
      assert.strictEqual(filesystem.existsSync(injectedFile), false);
      assert.doesNotMatch(buildDefaultFinishPrBody({ taskText }), /Closes #(unknown|N\/A)/);
    } finally {
      filesystem.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('keeps hostile task text literal in the default body', function () {
    if (process.platform === 'win32') this.skip();

    const cwd = filesystem.mkdtempSync(nodePath.join(tmpdir(), 'zeroshot-finish-default-'));
    const binDir = nodePath.join(cwd, 'bin');
    const argumentLog = nodePath.join(cwd, 'arguments.json');
    const injectedFile = nodePath.join(cwd, 'PWNED');
    const taskText = `$(touch ${injectedFile}) and \`touch ${injectedFile}\``;

    try {
      filesystem.mkdirSync(binDir);
      installArgumentRecorder(binDir, 'gh', true);
      const prompt = buildCompletionPrompt({
        contextSummary: taskText,
        taskText,
        issueTitle: 'Manual task',
      });
      runFile('/bin/sh', ['-c', prCreateCommand(prompt)], {
        cwd,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          ZEROSHOT_ARGUMENT_LOG: argumentLog,
        },
      });

      const [args] = JSON.parse(filesystem.readFileSync(argumentLog, 'utf8'));
      assert.ok(args[args.indexOf('--body') + 1].includes(taskText));
      assert.strictEqual(filesystem.existsSync(injectedFile), false);
    } finally {
      filesystem.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
