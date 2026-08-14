use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use openengine_cluster_protocol::LegacyShipRequest;
use tokio::sync::watch;

use tokio::time::{sleep, Duration};

use super::worker::{WorkerCommand, WorkerExecution, WorkerSpawnError, NODE_PROGRAM};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

pub(super) struct NodeWorkerFixture {
    root: PathBuf,
    script: PathBuf,
    pids: PathBuf,
    mutation: PathBuf,
}

impl NodeWorkerFixture {
    pub(super) fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "zeroshot-hosted-{label}-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("create hosted worker fixture");
        let script = root.join("worker.js");
        let pids = root.join("pids");
        let mutation = root.join("worker-mutation");
        fs::write(&script, WORKER_SCRIPT).expect("write hosted worker script");
        Self {
            root,
            script,
            pids,
            mutation,
        }
    }

    pub(super) fn command(&self, mode: &str, delay_ms: u64) -> WorkerCommand {
        let program = if Path::new(NODE_PROGRAM).is_file() {
            NODE_PROGRAM
        } else {
            "/usr/bin/node"
        };
        WorkerCommand {
            program: program.to_owned(),
            argv: vec![
                self.script.to_string_lossy().into_owned(),
                mode.to_owned(),
                self.pids.to_string_lossy().into_owned(),
                delay_ms.to_string(),
            ],
            current_dir: self.root.clone(),
            isolated: false,
            environment: BTreeMap::from([
                ("HOME".to_owned(), "/tmp/zeroshot-oecp".to_owned()),
                ("LANG".to_owned(), "C.UTF-8".to_owned()),
                ("NODE_ENV".to_owned(), "production".to_owned()),
                ("PATH".to_owned(), "/usr/local/bin:/usr/bin:/bin".to_owned()),
                ("GH_TOKEN".to_owned(), "git-canary".to_owned()),
                ("OPENAI_API_KEY".to_owned(), "provider-canary".to_owned()),
                (
                    "OPENAI_BASE_URL".to_owned(),
                    "https://openrouter.ai/api/v1".to_owned(),
                ),
                (
                    "ZEROSHOT_HOSTED_REPOSITORY".to_owned(),
                    "the-open-engine/zeroshot".to_owned(),
                ),
                ("ZEROSHOT_HOSTED_BASE_REVISION".to_owned(), "a".repeat(40)),
                ("ZEROSHOT_HOSTED_PROVIDER".to_owned(), "codex".to_owned()),
                (
                    "ZEROSHOT_HOSTED_MODEL_LEVEL".to_owned(),
                    "level2".to_owned(),
                ),
                (
                    "ZEROSHOT_ISOLATION_PROFILE".to_owned(),
                    "isolation.prepared-worktree@1".to_owned(),
                ),
                (
                    "ZEROSHOT_PROVIDER_PROFILE".to_owned(),
                    "provider.hosted-direct@1".to_owned(),
                ),
            ]),
        }
    }

    pub(super) fn pids_path(&self) -> PathBuf {
        self.pids.clone()
    }

    pub(super) fn mutation_path(&self) -> PathBuf {
        self.mutation.clone()
    }

    pub(super) fn recorded_pids(&self) -> Vec<u32> {
        fs::read_to_string(&self.pids)
            .expect("hosted worker recorded process tree")
            .lines()
            .map(|line| line.parse().expect("recorded pid is decimal"))
            .collect()
    }

    pub(super) async fn spawn(
        &self,
        request: &LegacyShipRequest,
        observer: watch::Receiver<bool>,
        mode: &str,
    ) -> WorkerExecution {
        match WorkerExecution::spawn_command(request, observer, self.command(mode, 0)).await {
            Ok(execution) => execution,
            Err(WorkerSpawnError::PreLaunch(error))
            | Err(WorkerSpawnError::PostLaunch { error, .. }) => {
                panic!("spawn adversarial worker: {error:?}")
            }
        }
    }

    pub(super) async fn assert_stopped(&self, execution: WorkerExecution) {
        let evidence = execution
            .prove_stopped()
            .await
            .expect("process tree is proven stopped");
        assert!(evidence.proves_tree_empty());
        assert_all_absent(&self.recorded_pids()).await;
    }
}

impl Drop for NodeWorkerFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

async fn assert_all_absent(pids: &[u32]) {
    for _ in 0..100 {
        if pids.iter().all(|pid| !process_exists(*pid)) {
            return;
        }
        sleep(Duration::from_millis(10)).await;
    }
    let live = pids
        .iter()
        .copied()
        .filter(|pid| process_exists(*pid))
        .collect::<Vec<_>>();
    assert!(live.is_empty(), "descendants survived cleanup: {live:?}");
}

pub(super) fn all_processes_absent(pids: &[u32]) -> bool {
    pids.iter().all(|pid| !process_exists(*pid))
}

fn process_exists(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

const WORKER_SCRIPT: &str = r#"
'use strict';
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const mode = process.argv[2];
const pids = process.argv[3];
const delay = Number(process.argv[4]);
fs.appendFileSync(pids, `${process.pid}\n`);
process.on('SIGTERM', () => {});
if (mode === 'grandchild') {
  setInterval(() => {}, 1000);
  return;
}
if (mode === 'child') {
  spawn(process.execPath, [__filename, 'grandchild', pids, String(delay)], {
    stdio: 'ignore'
  });
  setInterval(() => {}, 1000);
  return;
}
const expectedEnv = [
  'GH_TOKEN', 'HOME', 'LANG', 'NODE_ENV', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'PATH',
  'ZEROSHOT_HOSTED_BASE_REVISION', 'ZEROSHOT_HOSTED_MODEL_LEVEL',
  'ZEROSHOT_HOSTED_PROVIDER', 'ZEROSHOT_HOSTED_REPOSITORY',
  'ZEROSHOT_ISOLATION_PROFILE', 'ZEROSHOT_PROVIDER_PROFILE'
];
if (JSON.stringify(Object.keys(process.env).sort()) !== JSON.stringify(expectedEnv.sort())) {
  throw new Error('unexpected inherited environment');
}
if (process.cwd() !== require('path').dirname(pids)) {
  throw new Error('worker cwd escaped prepared workspace');
}
if (mode === 'exit-before-start') process.exit(1);
for (const fd of fs.readdirSync('/proc/self/fd')) {
  if (Number(fd) <= 2) continue;
  let target;
  try { target = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { continue; }
  if (target.includes('/run/zeroshot-capsule-agent')) {
    throw new Error('trusted service descriptor reached worker');
  }
}
spawn(process.execPath, [__filename, 'child', pids, String(delay)], {
  stdio: 'ignore'
});
process.stderr.write('OPENROUTER_STDERR_CANARY\n');
function respondStarted(frame) {
  const count = fs.readFileSync(pids, 'utf8').trim().split('\n').filter(Boolean).length;
  if (count < 3) {
    setTimeout(() => respondStarted(frame), 5);
    return;
  }
  if (mode === 'bad-start') {
    fs.writeFileSync(require('path').join(require('path').dirname(pids), 'worker-mutation'),
      'mutation before malformed start receipt');
    process.stdout.write(JSON.stringify({
      type: 'response', id: frame.id + 1, ok: true, result: {}
    }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    type: 'response', id: frame.id, ok: true,
    result: { state: 'running', clusterId: 'hosted-test', sequence: 1,
      stopRequested: false, terminal: false }
  }) + '\n');
}
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.method === 'start') {
    respondStarted(frame);
  } else if (frame.method === 'result') {
    if (mode === 'bad-result') {
      process.stdout.write(JSON.stringify({
        type: 'response', id: frame.id + 1, ok: true, result: {}
      }) + '\n');
      return;
    }
    if (mode === 'failed-result') {
      process.stdout.write(JSON.stringify({
        type: 'response', id: frame.id, ok: true,
        result: { state: 'failed', clusterId: 'hosted-test', finishedAt: 1,
          outcome: { status: 'verified',
            output: { secret: 'OPENROUTER_FAILURE_CANARY' }, artifacts: [] } }
      }) + '\n', () => process.exit(0));
      return;
    }
    setTimeout(() => process.stdout.write(JSON.stringify({
      type: 'response', id: frame.id, ok: true,
      result: { state: 'completed', clusterId: 'hosted-test', finishedAt: 1,
        result: { summary: 'OPENROUTER_RESULT_CANARY', status: 'succeeded', artifacts: [],
          repository: 'the-open-engine/zeroshot', branch: 'zeroshot/hosted-test',
          headRevision: 'b'.repeat(40),
          pullRequestUrl: 'https://github.com/the-open-engine/zeroshot/pull/1' } }
    }) + '\n', () => process.exit(0)), delay);
  }
});
input.on('close', () => process.exit(0));
"#;
