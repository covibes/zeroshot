use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use openengine_cluster_protocol::{
    RunAttachEventNotification, RunAttachParams, RunConnectionValues, RunForceParams, RunId,
    RunListParams, RunLogEventNotification, RunLogsParams, RunStatusParams, RunSubmitResult,
    RunTitle, RunWatchParams, RuntimePlan,
};
use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::{json, Value};

use super::*;

#[path = "support/attach.rs"]
mod attach;
use attach::{attach_event, AttachBehavior};
#[path = "support/cursor.rs"]
mod cursor;
use cursor::{record_cursor_call, CursorCallArgs};
#[path = "support/lifecycle.rs"]
mod lifecycle;
use lifecycle::{permanent_reopen_watch, queued_watch};

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Call {
    TargetAdd {
        name: String,
        url: String,
        direct: bool,
    },
    TargetLogin {
        name: String,
    },
    TargetSetup {
        name: String,
        repository: String,
        default_branch: Option<String>,
    },
    Submit {
        target: Option<String>,
        title: RunTitle,
        runtime: RuntimePlan,
        input: Value,
        connections: RunConnectionValues,
        github_token: Option<String>,
        branch: Option<String>,
        submission_key: String,
    },
    Watch {
        target: Option<String>,
        run_id: String,
        from_cursor: Option<String>,
    },
    List {
        target: Option<String>,
    },
    Status {
        target: Option<String>,
        run_id: String,
    },
    Logs {
        target: Option<String>,
        run_id: String,
        from_cursor: Option<String>,
        execution: Option<String>,
    },
    Attach {
        target: Option<String>,
        run_id: String,
        execution: String,
    },
    Force {
        target: Option<String>,
        run_id: String,
    },
}

pub(super) struct FakeSubscription<E> {
    items: Option<VecDeque<FakeSubscriptionStep<E>>>,
}

enum FakeSubscriptionStep<E> {
    Item(CliSubscriptionItem<E>),
    Disconnected,
    ProtocolError,
}

impl<E> FakeSubscription<E> {
    fn items(items: Vec<CliSubscriptionItem<E>>) -> Self {
        Self {
            items: Some(items.into_iter().map(FakeSubscriptionStep::Item).collect()),
        }
    }

    fn disconnect_after(items: Vec<CliSubscriptionItem<E>>) -> Self {
        let mut steps = items
            .into_iter()
            .map(FakeSubscriptionStep::Item)
            .collect::<VecDeque<_>>();
        steps.push_back(FakeSubscriptionStep::Disconnected);
        Self { items: Some(steps) }
    }

    fn protocol_error() -> Self {
        Self {
            items: Some(VecDeque::from([FakeSubscriptionStep::ProtocolError])),
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
            Some(items) => match items.pop_front() {
                Some(FakeSubscriptionStep::Item(item)) => Ok(Some(item)),
                Some(FakeSubscriptionStep::Disconnected) => Err(NativeV2CliError::Disconnected),
                Some(FakeSubscriptionStep::ProtocolError) => {
                    Err(NativeV2CliError::Protocol("attach rejected".to_owned()))
                }
                None => Ok(None),
            },
            None => std::future::pending().await,
        }
    }
}

#[derive(Clone, Default)]
pub(super) struct FakeBackend {
    calls: Arc<Mutex<Vec<Call>>>,
    pending_watch: bool,
    reconnect_watch: bool,
    permanent_reopen_watch: bool,
    reconnect_logs: bool,
    attach_behavior: AttachBehavior,
    failed_watch: bool,
    queued_lifecycle: bool,
}

#[derive(Clone, Copy)]
pub(super) enum CursorCallKind {
    Watch,
    Logs,
}

impl FakeBackend {
    pub(super) fn with_pending_watch() -> Self {
        Self {
            pending_watch: true,
            ..Self::default()
        }
    }

    pub(super) fn with_reconnecting_watch() -> Self {
        Self {
            reconnect_watch: true,
            ..Self::default()
        }
    }

    pub(super) fn with_reconnecting_logs() -> Self {
        Self {
            reconnect_logs: true,
            ..Self::default()
        }
    }

    pub(super) fn with_failed_watch() -> Self {
        Self {
            failed_watch: true,
            ..Self::default()
        }
    }

    pub(super) fn with_queued_lifecycle() -> Self {
        Self {
            queued_lifecycle: true,
            ..Self::default()
        }
    }

    pub(super) fn with_reconnecting_attach_after_disconnect() -> Self {
        Self {
            attach_behavior: AttachBehavior::Disconnect,
            ..Self::default()
        }
    }

    pub(super) fn with_reconnecting_attach_after_eof() -> Self {
        Self {
            attach_behavior: AttachBehavior::EndOfStream,
            ..Self::default()
        }
    }

    pub(super) fn with_reconnecting_attach_after_slow_consumer() -> Self {
        Self {
            attach_behavior: AttachBehavior::SlowConsumer,
            ..Self::default()
        }
    }

    pub(super) fn with_failed_attach() -> Self {
        Self {
            attach_behavior: AttachBehavior::ProtocolError,
            ..Self::default()
        }
    }

    pub(super) fn calls(&self) -> Vec<Call> {
        self.calls.lock().assert_value().clone()
    }
}

#[async_trait]
impl NativeV2CliBackend for FakeBackend {
    type Watch = FakeSubscription<CliRunWatchEventNotification>;
    type Logs = FakeSubscription<RunLogEventNotification>;
    type Attach = FakeSubscription<RunAttachEventNotification>;

    async fn target_add(&self, request: TargetAdd) -> Result<(), NativeV2CliError> {
        self.calls.lock().assert_value().push(Call::TargetAdd {
            name: request.name,
            url: request.url,
            direct: request.direct,
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
            default_branch: request
                .default_branch
                .map(|branch| branch.as_str().to_owned()),
        });
        Ok(())
    }

    async fn run_submit(
        &self,
        target: Option<&str>,
        request: PreparedRunRequest,
    ) -> Result<RunSubmitResult, NativeV2CliError> {
        let PreparedRunRequest {
            intent,
            connections,
            github_token,
            run_id: _,
        } = request;
        self.calls.lock().assert_value().push(Call::Submit {
            target: target.map(str::to_owned),
            title: intent.title,
            runtime: intent.runtime,
            input: intent.initial_input,
            connections,
            github_token,
            branch: intent.branch.map(|branch| branch.as_str().to_owned()),
            submission_key: intent.submission_key.as_str().to_owned(),
        });
        Ok(RunSubmitResult {
            run_id: RunId::new("run-public"),
        })
    }

    async fn run_list(
        &self,
        target: Option<&str>,
        _params: RunListParams,
    ) -> Result<CliRunListResult, NativeV2CliError> {
        self.calls.lock().assert_value().push(Call::List {
            target: target.map(str::to_owned),
        });
        let runs = self
            .queued_lifecycle
            .then(|| status("run-public", "queued"))
            .into_iter()
            .collect();
        Ok(CliRunListResult { runs })
    }

    async fn run_status(
        &self,
        target: Option<&str>,
        params: RunStatusParams,
    ) -> Result<CliRunStatusResult, NativeV2CliError> {
        self.calls.lock().assert_value().push(Call::Status {
            target: target.map(str::to_owned),
            run_id: params.run_id.as_str().to_owned(),
        });
        Ok(status(
            "run-public",
            if self.queued_lifecycle {
                "queued"
            } else {
                "admitted"
            },
        ))
    }

    async fn run_watch(
        &self,
        target: Option<&str>,
        params: RunWatchParams,
    ) -> Result<Self::Watch, NativeV2CliError> {
        let attempt = record_cursor_call(
            self,
            CursorCallArgs {
                kind: CursorCallKind::Watch,
                target,
                run_id: &params.run_id,
                from_cursor: params.from_cursor.as_ref(),
                execution: None,
            },
        );
        if self.pending_watch {
            return Ok(FakeSubscription::pending());
        }
        if let Some(result) = permanent_reopen_watch(self, &params, attempt) {
            return result;
        }
        if self.queued_lifecycle {
            return Ok(queued_watch(&params, attempt));
        }
        if self.reconnect_watch && attempt == 1 {
            return Ok(FakeSubscription::disconnect_after(vec![
                CliSubscriptionItem::Event(
                    serde_json::from_value(json!({
                        "subscriptionId":"watch-1",
                        "runId":params.run_id,
                        "title":"Repair checkout",
                        "source":source(),
                        "size":"medium",
                        "cursor":"v2:1",
                        "status":{"phase":"running","activeExecutions":[]}
                    }))
                    .assert_value(),
                ),
            ]));
        }
        let terminal_result = if self.failed_watch {
            json!({"status":"failed","reason":"worker_failed"})
        } else {
            json!({"status":"succeeded","output":null})
        };
        Ok(FakeSubscription::items(vec![CliSubscriptionItem::Event(
            serde_json::from_value(json!({
                "subscriptionId":"watch-1",
                "runId":params.run_id,
                "title":"Repair checkout",
                "source":source(),
                "size":"medium",
                "cursor":"v2:2",
                "status":{"phase":"finished","terminalResult":terminal_result,"metadata":{}}
            }))
            .assert_value(),
        )]))
    }

    async fn run_logs(
        &self,
        target: Option<&str>,
        params: RunLogsParams,
    ) -> Result<Self::Logs, NativeV2CliError> {
        let attempt = record_cursor_call(
            self,
            CursorCallArgs {
                kind: CursorCallKind::Logs,
                target,
                run_id: &params.run_id,
                from_cursor: params.from_cursor.as_ref(),
                execution: params.execution.as_ref(),
            },
        );
        if self.reconnect_logs {
            let (cursor, message) = if attempt == 1 {
                ("v2:4", "before disconnect")
            } else {
                ("v2:5", "after reconnect")
            };
            let event = CliSubscriptionItem::Event(
                serde_json::from_value(json!({
                    "subscriptionId":format!("logs-{attempt}"),
                    "runId":params.run_id,
                    "cursor":cursor,
                    "record":{"level":"info","target":"agent","message":message}
                }))
                .assert_value(),
            );
            if attempt == 1 {
                return Ok(FakeSubscription::items(vec![event]));
            }
            return Ok(FakeSubscription::items(vec![
                event,
                CliSubscriptionItem::Closed {
                    reason: SubscriptionCloseReason::Done,
                },
            ]));
        }
        Ok(FakeSubscription::items(vec![CliSubscriptionItem::Closed {
            reason: SubscriptionCloseReason::Done,
        }]))
    }

    async fn run_attach(
        &self,
        target: Option<&str>,
        params: RunAttachParams,
    ) -> Result<Self::Attach, NativeV2CliError> {
        let mut calls = self.calls.lock().assert_value();
        let attempt = calls
            .iter()
            .filter(|call| matches!(call, Call::Attach { .. }))
            .count()
            + 1;
        calls.push(Call::Attach {
            target: target.map(str::to_owned),
            run_id: params.run_id.as_str().to_owned(),
            execution: params.execution.as_str().to_owned(),
        });
        drop(calls);

        match (self.attach_behavior, attempt) {
            (AttachBehavior::Done, _) => {
                Ok(FakeSubscription::items(vec![CliSubscriptionItem::Closed {
                    reason: SubscriptionCloseReason::Done,
                }]))
            }
            (AttachBehavior::ProtocolError, _) => Ok(FakeSubscription::protocol_error()),
            (_, 2..) => Ok(FakeSubscription::items(vec![
                attach_event(&params, attempt, "after reconnect"),
                CliSubscriptionItem::Closed {
                    reason: SubscriptionCloseReason::Done,
                },
            ])),
            (AttachBehavior::Disconnect, _) => {
                Ok(FakeSubscription::disconnect_after(vec![attach_event(
                    &params,
                    attempt,
                    "before reconnect",
                )]))
            }
            (AttachBehavior::EndOfStream, _) => Ok(FakeSubscription::items(vec![attach_event(
                &params,
                attempt,
                "before reconnect",
            )])),
            (AttachBehavior::SlowConsumer, _) => Ok(FakeSubscription::items(vec![
                attach_event(&params, attempt, "before reconnect"),
                CliSubscriptionItem::Closed {
                    reason: SubscriptionCloseReason::SlowConsumer,
                },
            ])),
        }
    }

    async fn run_force(
        &self,
        target: Option<&str>,
        params: RunForceParams,
    ) -> Result<CliRunForceResult, NativeV2CliError> {
        self.calls.lock().assert_value().push(Call::Force {
            target: target.map(str::to_owned),
            run_id: params.run_id.as_str().to_owned(),
        });
        serde_json::from_value(json!({
            "runId":params.run_id,
            "title":"Repair checkout",
            "source":source(),
            "size":"medium",
            "atCursor":"v2:3",
            "status":{"phase":"stopping","activeExecutions":[]}
        }))
        .map_err(NativeV2CliError::OutputJson)
    }
}

pub(super) struct ImmediateDetach;

#[async_trait]
impl DetachSignal for ImmediateDetach {
    async fn wait(&mut self) {}
}
