use std::any::Any;
use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    IdempotencyKey, NodeName, PositiveInteger, RunAttachParams, RunId, RunLogsParams, RunStatus,
    RunStatusParams, RunWatchParams, Sha256Digest, WorkerOutcome, WorkerRef,
};
use serde_json::Value;
use tokio::sync::{Barrier, Notify};

use super::*;
use crate::execution::SessionScope;
use crate::full_v1_reducer::StructuralOccurrence;
use crate::native_v2_contract::{AdmittedRun, ExecutionRef, NodeInvocation, NodeRuntimeBinding};
use crate::native_v2_runner::{
    DriverControl, DriverInvocation, LiveOutput, LiveOutputStream, NativeNodeRunner, NodeDriver,
    NodeRunRequest, NodeRunner, NodeRunnerError, NodeSession, ResolvedEnvironment, SessionFactory,
};
use crate::v2_run_ledger::fake::FakeRunLedger;
use crate::v2_run_ledger::{CreateRun, RunEvent, RunLedger, SafeLogLine};

fn agent_binding() -> NodeRuntimeBinding {
    crate::native_v2_runner::test_support::binding(SessionScope::Execution)
}

fn admitted_run() -> AdmittedRun {
    crate::native_v2_runner::test_support::admitted()
}

async fn ledger_run(run: &str) -> (Arc<FakeRunLedger>, RunId) {
    let ledger = Arc::new(FakeRunLedger::new());
    let run_id = RunId::new(run);
    ledger
        .create_or_get(CreateRun {
            run_id: run_id.clone(),
            submission_key: IdempotencyKey::new(format!("submission-{run}")).assert_value(),
            submission_digest: Sha256Digest::new("a".repeat(64)).assert_value(),
            admitted: admitted_run(),
        })
        .await
        .assert_value();
    (ledger, run_id)
}

fn reference(run_id: &RunId, node: &str, execution: u64) -> ExecutionRef {
    ExecutionRef {
        run_id: run_id.clone(),
        node: NodeName::new(node).assert_value(),
        node_instance: crate::native_v2_contract::NodeInstanceId::new(execution).assert_value(),
        execution: ExecutionId::new(execution).assert_value(),
    }
}

fn public_reference(reference: &ExecutionRef) -> PublicExecutionRef {
    let result = opaque_execution(reference);
    assert!(
        result.is_ok(),
        "test execution reference must be projectable"
    );
    let mut values = result.ok().into_iter().collect::<Vec<_>>();
    values.swap_remove(0)
}

fn started(reference: &ExecutionRef) -> RunEvent {
    RunEvent::NodeStarted {
        reference: reference.clone(),
        occurrence: StructuralOccurrence {
            node: reference.node.clone(),
            map_indices: Vec::new(),
        },
        attempt: PositiveInteger::new(1).assert_value(),
        input: Value::Null,
    }
}

struct LiveAttachFixture {
    ledger: Arc<FakeRunLedger>,
    run_id: RunId,
    reference: ExecutionRef,
    first_emitted: Arc<Notify>,
    release: Arc<Notify>,
    service: NativeV2Observability,
    handle: crate::native_v2_runner::NodeHandle,
    durable: crate::native_v2_runner::DurableOutput,
    registration: LiveExecutionRegistration,
}

async fn live_attach_fixture(run: &str) -> LiveAttachFixture {
    let (ledger, run_id) = ledger_run(run).await;
    let reference = reference(&run_id, "worker", 1);
    ledger
        .append(&run_id, vec![RunEvent::RunStarted, started(&reference)])
        .await
        .assert_value();
    let first_emitted = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let runner = NativeNodeRunner::new(
        &admitted_run(),
        Arc::new(ControlledDriver {
            first_emitted: first_emitted.clone(),
            release: release.clone(),
        }),
        Arc::new(FakeSessions),
    )
    .assert_value();
    let binding = agent_binding();
    let mut handle = runner
        .start(NodeRunRequest {
            invocation: NodeInvocation {
                reference: reference.clone(),
                worker: WorkerRef::new("agent.worker@1").assert_value(),
                input: Value::Null,
                binding: binding.clone(),
            },
            environment: ResolvedEnvironment::exact(&binding, BTreeMap::new()).assert_value(),
        })
        .await
        .assert_value();
    let service = NativeV2Observability::new(ledger.clone());
    let durable = handle.take_initial_output().assert_value();
    let registration = service
        .register_live_execution(&reference, handle.live_output_source().assert_value())
        .await
        .assert_value();
    LiveAttachFixture {
        ledger,
        run_id,
        reference,
        first_emitted,
        release,
        service,
        handle,
        durable,
        registration,
    }
}

async fn attach_working(fixture: &LiveAttachFixture) -> (RunAttachParams, RunAttachSubscription) {
    let params = RunAttachParams {
        run_id: fixture.run_id.clone(),
        execution: fixture.registration.public_execution().clone(),
    };
    let (_, mut attached) = fixture.service.attach(params.clone()).await.assert_value();
    assert!(matches!(
        attached.recv().await.assert_value().event,
        AgentAttachEvent::Working {}
    ));
    (params, attached)
}

async fn assert_attach_settled(attached: &mut RunAttachSubscription) {
    assert!(matches!(
        attached.recv().await.assert_value().event,
        AgentAttachEvent::Settled {}
    ));
}

#[path = "tests/attach.rs"]
mod attach;
#[path = "tests/errors.rs"]
mod errors;
#[path = "tests/logs.rs"]
mod logs;
#[path = "tests/parallel_attach.rs"]
mod parallel_attach;
#[path = "tests/status.rs"]
mod status;
#[path = "tests/watch.rs"]
mod watch;

use attach::{ControlledDriver, FakeSessions, ParallelVerifierDriver};
use errors::{attach_text, persist_output};
use status::cursor_fixture;

use openengine_cluster_testkit::assertions::{AssertValue};
