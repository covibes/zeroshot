//! Unit-level `AgentAttachStore`/`AgentAttachEventStream` contract tests against a minimal
//! fixture store, independent of the testkit's `InMemoryAdmissionStore`.

use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    AgentAttachEvent, AgentAttachParams, AgentAttachResult, BoundedAssistantOutput, ExecutionRef,
    GetParams, GetResult, InitializeParams, InitializeResult, ServerCapabilities, SubscriptionId,
    GONE, INVALID_PHASE, MAX_AGENT_ATTACH_EVENT_ENCODED_BYTES, NOT_FOUND,
};
use openengine_cluster_server::agent_attach::fixtures::{
    AgentAttachFixtureBackend, AgentAttachFixtureStore,
};
use openengine_cluster_server::agent_attach::{
    default_agent_attach_error_mapping, subscribe_and_stream_agent_attach, AgentAttachEventStream,
    AgentAttachHandle, AgentAttachStore, AgentAttachStreamItem,
    SubscribeAndStreamAgentAttachRequest,
};
use openengine_cluster_server::watch::fixtures::{await_ndjson_shutdown, spawn_ndjson};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext, Dispatcher};
use serde_json::json;
use tokio::io::BufReader;

#[path = "capability_default_support/mod.rs"]
mod capability_default_support;
#[path = "ndjson_test_support/mod.rs"]
mod ndjson_test_support;
#[path = "oversized_event_wire_support/mod.rs"]
mod oversized_event_wire_support;
#[path = "oversized_id_backend_support/mod.rs"]
mod oversized_id_backend_support;
use capability_default_support::bare_watch_dispatcher;
use ndjson_test_support::{read_value, request_line, write_line};
use oversized_event_wire_support::{
    assert_oversized_event_does_not_block_unary_responses, OversizedEventWire,
};
use oversized_id_backend_support::oversized_id_backend;

/// An arbitrary, generously large queue capacity for tests that don't care about the exact
/// overflow point.
const AMPLE_CAPACITY: usize = 8;

fn sample_execution_ref() -> ExecutionRef {
    ExecutionRef::new("execution-1").expect("fixture execution ref must be valid")
}

fn agent_attach_params() -> AgentAttachParams {
    AgentAttachParams {
        execution: sample_execution_ref(),
    }
}

fn sample_output_event(text: &str) -> AgentAttachEvent {
    AgentAttachEvent::Output {
        text: BoundedAssistantOutput::new(text).expect("fixture output must be valid"),
    }
}

#[tokio::test]
async fn default_agent_attach_is_unsupported_unless_backend_overrides_it() {
    let dispatcher = bare_watch_dispatcher(AMPLE_CAPACITY);
    let Err(error) = dispatcher.agent_attach(agent_attach_params()).await else {
        panic!("expected the default agent_attach implementation to be unsupported");
    };
    assert_eq!(error.code, INVALID_PHASE);
}

#[tokio::test]
async fn unknown_execution_ref_returns_not_found_with_no_private_id_in_details() {
    let store = Arc::new(AgentAttachFixtureStore::new());
    let dispatcher = Dispatcher::new(
        AgentAttachFixtureBackend::new(store),
        ConnectionContext::default(),
    );

    let Err(error) = dispatcher.agent_attach(agent_attach_params()).await else {
        panic!("expected an unknown execution ref to be rejected");
    };
    assert_eq!(error.code, NOT_FOUND);
    assert!(error.details.is_none());
}

#[tokio::test]
async fn wrong_cluster_execution_ref_returns_not_found_indistinguishable_from_unknown() {
    let store_a = Arc::new(AgentAttachFixtureStore::new());
    let store_b = Arc::new(AgentAttachFixtureStore::new());
    // Minted against store_a's cluster, then resolved against store_b's: a per-cluster-scoped
    // store cannot and must not distinguish this from a truly unknown ref.
    store_a.register_active(sample_execution_ref()).await;

    let dispatcher_b = Dispatcher::new(
        AgentAttachFixtureBackend::new(store_b),
        ConnectionContext::default(),
    );
    let Err(error) = dispatcher_b.agent_attach(agent_attach_params()).await else {
        panic!("expected a wrong-cluster execution ref to be rejected");
    };
    assert_eq!(error.code, NOT_FOUND);
    assert!(error.details.is_none());
}

#[tokio::test]
async fn inactive_execution_ref_returns_gone() {
    let store = Arc::new(AgentAttachFixtureStore::new());
    let execution = sample_execution_ref();
    store.register_active(execution.clone()).await;
    store.mark_inactive(&execution).await;

    let dispatcher = Dispatcher::new(
        AgentAttachFixtureBackend::new(store),
        ConnectionContext::default(),
    );
    let Err(error) = dispatcher.agent_attach(agent_attach_params()).await else {
        panic!("expected an inactive execution ref to be rejected");
    };
    assert_eq!(error.code, GONE);
}

#[tokio::test]
async fn agent_attach_streams_only_future_events_no_replay() {
    let store = Arc::new(AgentAttachFixtureStore::new());
    let execution = sample_execution_ref();
    store.register_active(execution.clone()).await;
    let dispatcher = Dispatcher::new(
        AgentAttachFixtureBackend::new(Arc::clone(&store)),
        ConnectionContext::default(),
    );

    // Published before the subscription is established: `agent_attach` has no retained history,
    // so this must never be observed.
    store
        .publish(&execution, sample_output_event("before subscribing"))
        .await;

    let (_result, mut stream, _handle) = dispatcher
        .agent_attach(agent_attach_params())
        .await
        .unwrap();

    store
        .publish(&execution, sample_output_event("after subscribing"))
        .await;
    let item = stream.next().await.unwrap();
    let AgentAttachStreamItem::Event(AgentAttachEvent::Output { text }) = item else {
        panic!("expected a live output event");
    };
    assert_eq!(text.as_str(), "after subscribing");
}

// `dropping_the_handle_cancels_without_delivering_more_events`,
// `cancelling_wakes_an_already_pending_idle_next_call`, and `queue_overflow_closes_with_slow_consumer`
// have no counterpart here: `AgentAttachEventStream`/`AgentAttachHandle` are plain type aliases for
// `crate::subscription_stream`'s generic `BoundedEventStream<E>`/`BoundedEventHandle` (see
// `agent_attach.rs`), so those behaviors are already exhaustively covered once, generically, by
// `tests/logs.rs`'s identical aliases over `LogRecord`; re-testing them per `E` would exercise the
// exact same shared code path a second time.

// An `agent_attach`-only backend whose subscription id is deliberately pathologically large --
// large enough on its own to push `AgentAttachEventNotification`'s encoded size over
// `MAX_AGENT_ATTACH_EVENT_ENCODED_BYTES`, even though every other field is already bounded well
// under that ceiling. Delegates `initialize`/`get` to a wrapped `AgentAttachFixtureBackend` and
// overrides only `agent_attach`.
oversized_id_backend! {
    name: OversizedIdAgentAttachBackend,
    inner: AgentAttachFixtureBackend,
    method: agent_attach,
    params: AgentAttachParams,
    result: AgentAttachResult,
    stream: AgentAttachEventStream,
    handle: AgentAttachHandle,
    body: |self, params, queue_capacity| {
        let store: Arc<dyn AgentAttachStore> =
            Arc::clone(&self.inner.store) as Arc<dyn AgentAttachStore>;
        let subscription_id = SubscriptionId::new("s".repeat(MAX_AGENT_ATTACH_EVENT_ENCODED_BYTES));
        subscribe_and_stream_agent_attach(
            &store,
            SubscribeAndStreamAgentAttachRequest {
                execution: params.execution,
                subscription_id,
                queue_capacity,
            },
            default_agent_attach_error_mapping,
        )
        .await
    },
}

#[tokio::test]
async fn oversized_event_encoding_ends_only_that_subscription_without_panicking() {
    let store = Arc::new(AgentAttachFixtureStore::new());
    let execution = sample_execution_ref();
    store.register_active(execution.clone()).await;
    let (mut write, read, server) = spawn_ndjson(OversizedIdAgentAttachBackend {
        inner: AgentAttachFixtureBackend::new(Arc::clone(&store)),
    });
    let mut read = BufReader::new(read);

    // Encodes to well over `MAX_AGENT_ATTACH_EVENT_ENCODED_BYTES` purely because of the backend's
    // pathologically large subscription id; the notification loop must drop it silently instead
    // of panicking the server task.
    assert_oversized_event_does_not_block_unary_responses(
        OversizedEventWire {
            write: &mut write,
            read: &mut read,
        },
        "agent/attach",
        json!({ "execution": "execution-1" }),
        || store.publish(&execution, sample_output_event("won't fit")),
    )
    .await;

    drop(write);
    await_ndjson_shutdown(server).await;
}

#[tokio::test]
async fn agent_attach_capability_toggle_does_not_alter_durable_fold_or_execution() {
    let store = Arc::new(AgentAttachFixtureStore::new());
    let enabled_backend = AgentAttachFixtureBackend::new(Arc::clone(&store));
    let enabled = enabled_backend
        .initialize(
            &ConnectionContext::default(),
            InitializeParams {
                protocol_version: openengine_cluster_protocol::PROTOCOL_VERSION.to_owned(),
            },
        )
        .await
        .unwrap();
    assert!(enabled.capabilities.agent_attach);
    assert_eq!(
        enabled.status,
        openengine_cluster_protocol::ClusterStatus::empty()
    );

    struct DisabledBackend;
    #[async_trait]
    impl ClusterBackend for DisabledBackend {
        async fn initialize(
            &self,
            _context: &ConnectionContext,
            _params: InitializeParams,
        ) -> Result<InitializeResult, BackendError> {
            Ok(InitializeResult::new(
                ServerCapabilities::default(),
                openengine_cluster_protocol::ClusterStatus::empty(),
            ))
        }

        async fn get(
            &self,
            _context: &ConnectionContext,
            _params: GetParams,
        ) -> Result<GetResult, BackendError> {
            Ok(GetResult::empty())
        }
    }
    let disabled = DisabledBackend
        .initialize(
            &ConnectionContext::default(),
            InitializeParams {
                protocol_version: openengine_cluster_protocol::PROTOCOL_VERSION.to_owned(),
            },
        )
        .await
        .unwrap();
    assert!(!disabled.capabilities.agent_attach);
    // Toggling agent_attach changes only the advertised capability flag; both backends report the
    // exact same empty cluster status/lifecycle for identical get() requests.
    assert_eq!(enabled.status, disabled.status);
}

#[tokio::test]
async fn subscription_cancel_is_sole_post_establishment_operation() {
    let store = Arc::new(AgentAttachFixtureStore::new());
    let execution = sample_execution_ref();
    store.register_active(execution.clone()).await;
    let (mut write, read, server) =
        spawn_ndjson(AgentAttachFixtureBackend::new(Arc::clone(&store)));
    let mut read = BufReader::new(read);

    write_line(
        &mut write,
        &request_line(1, "agent/attach", json!({ "execution": "execution-1" })),
    )
    .await;
    let established = read_value(&mut read).await;
    let subscription_id = established["result"]["subscriptionId"]
        .as_str()
        .expect("agent/attach must establish a subscription")
        .to_owned();

    store
        .publish(&execution, sample_output_event("hello"))
        .await;
    let event = read_value(&mut read).await;
    assert_eq!(event["method"], "event");

    write_line(
        &mut write,
        &json!({
            "jsonrpc": "2.0",
            "method": "subscription/cancel",
            "params": { "subscriptionId": subscription_id }
        })
        .to_string(),
    )
    .await;

    // A synchronous round trip proves the cancel notification was already processed.
    write_line(&mut write, &request_line(2, "get", json!({}))).await;
    let get_response = read_value(&mut read).await;
    assert_eq!(get_response["id"], 2);

    drop(write);
    await_ndjson_shutdown(server).await;
}
