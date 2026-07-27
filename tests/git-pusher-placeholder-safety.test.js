const assert = require('node:assert');
const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Orchestrator = require('../src/orchestrator');

function writeCommandRecorder(binDir, commandName) {
  const commandPath = path.join(binDir, commandName);
  fs.writeFileSync(
    commandPath,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$ZEROSHOT_COMMAND_LOG"\n',
    'utf8'
  );
  fs.chmodSync(commandPath, 0o755);
}

function findPromptCommand(prompt, prefix) {
  return prompt.split('\n').find((line) => line.startsWith(prefix));
}

describe('git-pusher typed prompt assembly', function () {
  it('does not reinterpret issue placeholders inside a quoted remote', function () {
    if (process.platform === 'win32') this.skip();

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-git-pusher-safety-'));
    const gitRemote = 'remote-{{issue_number}}-{{issue_title}}';
    const injectedFile = path.join(cwd, 'PWNED');
    const issueTitle = `safe'; printf PWNED > ${injectedFile}; #`;
    execSync('git init', { cwd, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', gitRemote, 'https://github.com/acme/widgets.git'], {
      cwd,
      stdio: 'ignore',
    });
    const orchestrator = new Orchestrator({
      storageDir: path.join(cwd, 'storage'),
    });
    const config = { agents: [{ id: 'completion-detector' }] };

    try {
      orchestrator._applyAutoPrConfig(
        config,
        {
          number: 448,
          title: issueTitle,
          url: 'https://github.com/acme/widgets/issues/448',
        },
        {
          autoPr: true,
          cwd,
          requiredQualityGates: [],
        }
      );

      const prompt = config.agents.find((agent) => agent.id === 'git-pusher').prompt;
      const commands = [
        findPromptCommand(prompt, 'git commit -m '),
        findPromptCommand(prompt, 'git push -u -- '),
        findPromptCommand(prompt, 'gh pr create'),
      ];
      assert(commands.every(Boolean), 'expected commit, push, and PR creation commands');
      assert.match(commands[1], /remote-\{\{issue_number\}\}-\{\{issue_title\}\}/);

      const binDir = path.join(cwd, 'bin');
      const commandLog = path.join(cwd, 'commands.log');
      fs.mkdirSync(binDir);
      writeCommandRecorder(binDir, 'git');
      writeCommandRecorder(binDir, 'gh');

      for (const command of commands) {
        execFileSync('/bin/sh', ['-c', command], {
          cwd,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            ZEROSHOT_COMMAND_LOG: commandLog,
          },
        });
      }

      const recordedArguments = fs.readFileSync(commandLog, 'utf8').split('\n');
      assert(recordedArguments.includes(gitRemote), 'push remote must remain byte-for-byte intact');
      assert(
        recordedArguments.some((argument) => argument.includes(issueTitle)),
        'the issue title must remain one literal command argument'
      );
      assert.strictEqual(fs.existsSync(injectedFile), false, 'issue title must not execute');
    } finally {
      orchestrator.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
