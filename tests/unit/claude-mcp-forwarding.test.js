const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveMcpConfigArgs } = require('../../src/agent/agent-task-executor');

describe('Claude repository MCP forwarding', function () {
  const tempDirs = [];

  afterEach(function () {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeWorktree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-mcp-forward-'));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: test\n');
    return root;
  }

  function claudeArgs(root) {
    return resolveMcpConfigArgs({ config: { cwd: root }, worktree: { path: root } }, 'claude');
  }

  it('forwards the root MCP config path to the detached Claude task command', function () {
    const root = makeWorktree();
    const mcpPath = path.join(root, '.mcp.json');
    fs.writeFileSync(mcpPath, '{"mcpServers":{"root":{}}}\n');

    assert.deepStrictEqual(claudeArgs(root), ['--mcp-config', mcpPath]);
  });

  it('forwards the legacy Claude-directory MCP config when root config is absent', function () {
    const root = makeWorktree();
    const claudeDir = path.join(root, '.claude');
    fs.mkdirSync(claudeDir);
    const mcpPath = path.join(claudeDir, '.mcp.json');
    fs.writeFileSync(mcpPath, '{"mcpServers":{"legacy":{}}}\n');

    assert.deepStrictEqual(claudeArgs(root), ['--mcp-config', mcpPath]);
  });
});
