const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

const OVERLAY_PREFIX = 'zeroshot-omp-config-';
const OMP_CONFIG_OVERLAY_DIR_PATTERN = /^zeroshot-omp-config-[A-Za-z0-9_-]+$/u;
const OMP_CONFIG_OVERLAY_FILE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.yml$/u;

// Verified against tagged v17.2.1 source: packages/coding-agent/src/config/settings-schema.ts
// (key types/defaults) and packages/coding-agent/src/main.ts (HOST_DEFAULTED_SETTING_PATHS /
// RPC_BACKGROUND_DEFAULTED_SETTING_PATHS). RPC mode (docs/rpc.md) only re-applies its own
// neutral defaults for task.*/memory.backend/memories.enabled/advisor.*/tier.advisor/
// async.*/bash.autoBackground.* when a path is completely unconfigured at every settings
// layer; `todo.*` is explicitly caller-controlled and never host-defaulted in RPC mode
// (main.ts: "embedders need project-level opt-outs for reminder/prelude prompt injection").
// A host's ~/.omp/agent/config.yml or project .omp/config.yml can therefore change one of
// these workflow-altering namespaces out from under an unattended RPC worker. This overlay
// pins every one of them to its schema built-in default plus marketplace.autoUpdate off, so
// Zeroshot's worker behavior never depends on the host machine's OMP config. It deliberately
// never sets context/skills/rules/extensions/mcp keys, which keep flowing from native
// project/user config underneath this overlay.
const OVERLAY_BODY = `# Zeroshot-owned OMP safety overlay — do not add model/profile settings.
marketplace:
  autoUpdate: "off"
todo:
  enabled: true
  reminders: true
  remindersMax: 3
  eager: "default"
task:
  isolation:
    mode: "none"
    apply: true
    merge: "patch"
    commits: "generic"
  eager: "default"
  batch: true
  maxConcurrency: 32
  maxRecursionDepth: 2
  disabledAgents: []
  agentModelOverrides: {}
  agentPrewalk: {}
memory:
  backend: "off"
memories:
  enabled: false
advisor:
  enabled: false
  subagents: false
  syncBacklog: "off"
  immuneTurns: 3
tier:
  advisor: "none"
async:
  enabled: true
  maxJobs: 100
bash:
  autoBackground:
    enabled: false
    thresholdMs: 60000
`;

// Identity of the overlay *content*, not of any one temp file. A resumed session was produced
// under whatever workflow-altering defaults this body pinned; if the body changes (a Zeroshot
// upgrade retunes task.*/memory/advisor/async behaviour), continuing an old transcript under the
// new rules is execution drift, so this digest is part of the OMP execution fingerprint recorded
// with every resumable session (src/omp-execution-fingerprint.js).
const OMP_CONFIG_OVERLAY_DIGEST = `sha256:${createHash('sha256').update(OVERLAY_BODY, 'utf8').digest('hex')}`;

function createOmpConfigOverlay() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), OVERLAY_PREFIX), { mode: 0o700 });
  try {
    const file = path.join(dir, `${randomUUID()}.yml`);
    fs.writeFileSync(file, OVERLAY_BODY, { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') {
      fs.chmodSync(dir, 0o700);
      fs.chmodSync(file, 0o600);
    }
    return { dir, file };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function isCanonicalOmpConfigOverlayDirectory(overlayDir) {
  if (typeof overlayDir !== 'string' || !overlayDir || path.resolve(overlayDir) !== overlayDir) {
    return false;
  }
  return (
    path.dirname(overlayDir) === path.resolve(os.tmpdir()) &&
    OMP_CONFIG_OVERLAY_DIR_PATTERN.test(path.basename(overlayDir))
  );
}

module.exports = {
  OMP_CONFIG_OVERLAY_DIGEST,
  OMP_CONFIG_OVERLAY_DIR_PATTERN,
  OMP_CONFIG_OVERLAY_FILE_PATTERN,
  createOmpConfigOverlay,
  isCanonicalOmpConfigOverlayDirectory,
};
