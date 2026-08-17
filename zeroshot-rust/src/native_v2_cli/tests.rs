use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use openengine_cluster_protocol::{
    RunAttachEventNotification, RunAttachParams, RunForceParams, RunForceResult, RunId,
    RunListParams, RunListResult, RunLogEventNotification, RunLogsParams, RunStatusParams,
    RunStatusResult, RunSubmitParams, RunSubmitResult, RunWatchEventNotification, RunWatchParams,
};
use serde_json::{json, Value};

use super::*;

#[path = "tests/parser.rs"]
mod parser_tests;

#[derive(Clone, Debug, PartialEq)]
enum Call {
    TargetAdd {
        name: String,
        url: String,
    },
    TargetLogin {
        name: String,
    },
    TargetSetup {
        name: String,
        repository: String,
        runtime_config: PathBuf,
    },
    Submit {
        target: String,
        ship: bool,
        input: Value,
        submission_key: String,
    },
    Watch {
        target: String,
        run_id: String,
    },
    List {
        target: String,
    },
    Status {
        target: String,
        run_id: String,
    },
    Logs {
        target: String,
        run_id: String,
    },
    Attach {
        target: String,
        run_id: String,
        execution: String,
    },
    Force {
        target: String,
        run_id: String,
    },
}

struct FakeSubscription<E> {
    items: Option<VecDeque<CliSubscriptionItem<E>>>,
}

impl<E> FakeSubscription<E> {
    fn items(items: Vec<CliSubscriptionItem<E>>) -> Self {
        Self {
            items: Some(items.into()),
        }
    }

    fn pending() -> Self {
        Self { items: None }
    }
}

#[async_trait]
impl<E> CliSubscription<E> for FakeSubscription<E>
where
    E: Send,
{
    async fn next(&mut self) -> Result<Option<CliSubscriptionItem<E>>, NativeV2CliError> {
        match &mut self.items {
            Some(items) => Ok(items.pop_front()),
            None => std::future::pending().await,
        }
    }
}

#[derive(Clone, Default)]
struct FakeBackend {
    calls: Arc<Mutex<Vec<Call>>>,
    pending_watch: bool,
}

impl FakeBackend {
    fn with_pending_watch() -> Self {
        Self {
            pending_watch: true,
            ..Self::default()
        }
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().assert_value().clone()
    }
}

#[async_trait]
impl NativeV2CliBackend for FakeBackend {
    type Watch = FakeSubscription<RunWatchEventNotification>;
    type Logs = FakeSubscription<RunLogEventNotification>;
    type Attach = FakeSubscription<RunAttachEventNotification>;

    async fn target_add(&self, request: TargetAdd) -> Result<(), NativeV2CliError> {
        self.calls.lock().assert_value().push(Call::TargetAdd {
            name: request.name,
            url: request.url,
        });
        Ok(())
    }

    async fn target_login(&self, name: &str) -> Result<(), NativeV2CliError> {
        self.calls.lock().assert_value().push(Call::TargetLogin {
            name: name.to_owned(),
        });
        Ok(())
    }

    async fn target_setup(&self, request: TargetSetup) -> Result<(), NativeV2CliError> {
        self.calls.lock().assert_value().push(Call::TargetSetup {
            name: request.name,
            repository: request.repository,
            runtime_config: request.runtime_config,
        });
        Ok(())
    }

    async fn run_submit(
        &self,
        target: &str,
        params: RunSubmitParams,
    ) -> Result<RunSubmitResult, NativeV2CliError> {
        self.calls.lock().assert_value().push(Call::Submit {
            target: target.to_owned(),
            ship: params.ship,
            input: params.initial_input,
            submission_key: params.submission_key.as_str().to_owned(),
        });
        Ok(RunSubmitResult {
            run_id: RunId::new("run-public"),
        })
    }

    async fn run_list(
        &self,
        target: &str,
        _params: RunListParams,
    ) -> Result<RunListResult, NativeV2CliError> {
        self.calls.lock().assert_value().push(Call::List {
            target: target.to_owned(),
        });
        Ok(RunListResult { runs: Vec::new() })
    }

    async fn run_status(
        &self,
        target: &str,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, NativeV2CliError> {
        self.calls.lock().assert_value().push(Call::Status {
            target: target.to_owned(),
            run_id: params.run_id.as_str().to_owned(),
        });
        Ok(status("run-public", "admitted"))
    }

    async fn run_watch(
        &self,
        target: &str,
        params: RunWatchParams,
    ) -> Result<Self::Watch, NativeV2CliError> {
        self.calls.lock().assert_value().push(Call::Watch {
            target: target.to_owned(),
            run_id: params.run_id.as_str().to_owned(),
        });
        if self.pending_watch {
            return Ok(FakeSubscription::pending());
        }
        Ok(FakeSubscription::items(vec![CliSubscriptionItem::Event(
            serde_json::from_value(json!({
                "subscriptionId":"watch-1",
                "runId":params.run_id,
                "cursor":"v2:2",
                "status":{"phase":"finished","terminalResult":{"status":"succeeded","output":null}}
            }))
            .assert_value(),
        )]))
    }

    async fn run_logs(
        &self,
        target: &str,
        params: RunLogsParams,
    ) -> Result<Self::Logs, NativeV2CliError> {
        self.calls.lock().assert_value().push(Call::Logs {
            target: target.to_owned(),
            run_id: params.run_id.as_str().to_owned(),
        });
        Ok(FakeSubscription::items(Vec::new()))
    }

    async fn run_attach(
        &self,
        target: &str,
        params: RunAttachParams,
    ) -> Result<Self::Attach, NativeV2CliError> {
        self.calls.lock().assert_value().push(Call::Attach {
            target: target.to_owned(),
            run_id: params.run_id.as_str().to_owned(),
            execution: params.execution.as_str().to_owned(),
        });
        Ok(FakeSubscription::items(Vec::new()))
    }

    async fn run_force(
        &self,
        target: &str,
        params: RunForceParams,
    ) -> Result<RunForceResult, NativeV2CliError> {
        self.calls.lock().assert_value().push(Call::Force {
            target: target.to_owned(),
            run_id: params.run_id.as_str().to_owned(),
        });
        serde_json::from_value(json!({
            "runId":params.run_id,
            "atCursor":"v2:3",
            "status":{"phase":"stopping","activeExecutions":[]}
        }))
        .map_err(NativeV2CliError::OutputJson)
    }
}

struct ImmediateDetach;

#[async_trait]
impl DetachSignal for ImmediateDetach {
    async fn wait(&mut self) {}
}

fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

fn run_args(graph: &Path, input: &Path, extra: &[&str]) -> Vec<OsString> {
    let mut values = vec![
        OsString::from("run"),
        OsString::from("--target"),
        OsString::from("prod"),
        OsString::from("--graph"),
        graph.as_os_str().to_owned(),
        OsString::from("--input"),
        input.as_os_str().to_owned(),
    ];
    values.extend(extra.iter().map(OsString::from));
    values
}

struct FixtureFiles {
    directory: PathBuf,
    graph: PathBuf,
    input: PathBuf,
}

impl FixtureFiles {
    fn new(graph: Value, input: Value) -> Self {
        let mut random = [0_u8; 8];
        getrandom::fill(&mut random).assert_value();
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let directory = std::env::temp_dir().join(format!("zeroshot-v2-cli-{suffix}"));
        std::fs::create_dir(&directory).assert_value();
        let graph_path = directory.join("graph.json");
        let input_path = directory.join("input.json");
        std::fs::write(&graph_path, serde_json::to_vec(&graph).assert_value()).assert_value();
        std::fs::write(&input_path, serde_json::to_vec(&input).assert_value()).assert_value();
        Self {
            directory,
            graph: graph_path,
            input: input_path,
        }
    }
}

impl Drop for FixtureFiles {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.graph);
        let _ = std::fs::remove_file(&self.input);
        let _ = std::fs::remove_dir(&self.directory);
    }
}

fn graph() -> Value {
    json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{
            "kind":"record",
            "fields":{"task":{"type":{"kind":"string"},"required":true}}
        },
        "policy":{"policy":"policy.native-v2@1","default":"deny"},
        "root":{"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
    })
}

fn status(run_id: &str, phase: &str) -> RunStatusResult {
    serde_json::from_value(json!({
        "runId":run_id,
        "atCursor":"v2:1",
        "status":{"phase":phase}
    }))
    .assert_value()
}

#[tokio::test]
async fn run_follows_by_default_and_forwards_ship_and_submission_key_unchanged() {
    let files = FixtureFiles::new(graph(), json!({"task":"ship it"}));
    let command = parse_native_v2_args(run_args(
        &files.graph,
        &files.input,
        &["--ship", "--submission-key", "stable-key"],
    ))
    .assert_value();
    let backend = FakeBackend::default();
    let mut output = Vec::new();
    let outcome = execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut output)
        .await
        .assert_value();
    assert_eq!(outcome, CliOutcome::Finished);
    assert_eq!(
        backend.calls(),
        [
            Call::Submit {
                target: "prod".to_owned(),
                ship: true,
                input: json!({"task":"ship it"}),
                submission_key: "stable-key".to_owned(),
            },
            Call::Watch {
                target: "prod".to_owned(),
                run_id: "run-public".to_owned(),
            },
        ]
    );
    let lines = String::from_utf8(output).assert_value();
    assert!(lines.contains("\"runId\":\"run-public\""));
    assert!(lines.contains("\"phase\":\"finished\""));
}

#[tokio::test]
async fn detach_flag_returns_after_submit_without_opening_watch() {
    let files = FixtureFiles::new(graph(), json!({"task":"detach"}));
    let command =
        parse_native_v2_args(run_args(&files.graph, &files.input, &["-d"])).assert_value();
    let backend = FakeBackend::default();
    let outcome = execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut Vec::new())
        .await
        .assert_value();
    assert_eq!(outcome, CliOutcome::Detached);
    assert!(matches!(backend.calls().as_slice(), [Call::Submit { .. }]));
}

#[tokio::test]
async fn ctrl_c_detaches_observation_without_force_stop() {
    let files = FixtureFiles::new(graph(), json!({"task":"interrupt"}));
    let command = parse_native_v2_args(run_args(&files.graph, &files.input, &[])).assert_value();
    let backend = FakeBackend::with_pending_watch();
    let outcome = execute_native_v2_cli(command, &backend, &mut ImmediateDetach, &mut Vec::new())
        .await
        .assert_value();
    assert_eq!(outcome, CliOutcome::Detached);
    assert!(matches!(
        backend.calls().as_slice(),
        [Call::Submit { .. }, Call::Watch { .. }]
    ));
    assert!(
        !backend
            .calls()
            .iter()
            .any(|call| matches!(call, Call::Force { .. }))
    );
}

#[tokio::test]
async fn watch_closure_without_a_terminal_status_is_a_detach() {
    let subscription =
        FakeSubscription::<RunWatchEventNotification>::items(vec![CliSubscriptionItem::Closed {
            reason: SubscriptionCloseReason::Done,
        }]);
    let outcome = follow_watch(subscription, &mut NeverDetach, &mut Vec::new())
        .await
        .assert_value();
    assert_eq!(outcome, CliOutcome::Detached);
}

#[tokio::test]
async fn restarted_client_reconnects_with_public_run_id_only() {
    let backend = FakeBackend::default();
    for _client_process in 0..2 {
        let command =
            parse_native_v2_args(args(&["watch", "run-public", "--target", "prod"])).assert_value();
        let outcome = execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut Vec::new())
            .await
            .assert_value();
        assert_eq!(outcome, CliOutcome::Finished);
    }
    assert_eq!(
        backend.calls(),
        [
            Call::Watch {
                target: "prod".to_owned(),
                run_id: "run-public".to_owned(),
            },
            Call::Watch {
                target: "prod".to_owned(),
                run_id: "run-public".to_owned(),
            },
        ]
    );
}

use openengine_cluster_testkit::assertions::{AssertValue};

#[tokio::test]
async fn list_and_status_are_run_centric() {
    let backend = FakeBackend::default();
    for argv in [
        args(&["list", "--target", "prod"]),
        args(&["status", "run-8", "--target", "prod"]),
    ] {
        let command = parse_native_v2_args(argv).assert_value();
        execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut Vec::new())
            .await
            .assert_value();
    }
    assert_eq!(
        backend.calls(),
        [
            Call::List {
                target: "prod".to_owned(),
            },
            Call::Status {
                target: "prod".to_owned(),
                run_id: "run-8".to_owned(),
            },
        ]
    );
}

#[tokio::test]
async fn logs_attach_and_force_use_the_run_scoped_methods() {
    let backend = FakeBackend::default();
    for argv in [
        args(&["logs", "run-1", "--target", "prod"]),
        args(&["attach", "run-1", "exec-9", "--target", "prod"]),
        args(&["force-stop", "run-1", "--target", "prod"]),
    ] {
        let command = parse_native_v2_args(argv).assert_value();
        execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut Vec::new())
            .await
            .assert_value();
    }
    assert_eq!(
        backend.calls(),
        [
            Call::Logs {
                target: "prod".to_owned(),
                run_id: "run-1".to_owned(),
            },
            Call::Attach {
                target: "prod".to_owned(),
                run_id: "run-1".to_owned(),
                execution: "exec-9".to_owned(),
            },
            Call::Force {
                target: "prod".to_owned(),
                run_id: "run-1".to_owned(),
            },
        ]
    );
}
