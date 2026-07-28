//! Generated `agent_attach` golden fixtures. `agent-attach-session.json` is produced by driving a
//! minimal real dispatcher configured with an [`InMemoryAgentAttachStore`] through an
//! `agent/attach` subscription and recording every event an actual subscriber receives; the
//! remaining fixtures document standalone wire shapes for request/close framing that no single
//! session exercises. Unlike `logs_artifacts.rs`, this does not run through
//! `AdmissionCoordinator`: `agent_attach`'s `ExecutionRef` resolution has no production backend
//! yet (`#686` owns the native producer/adapter), so this reuses the server crate's minimal
//! `agent_attach: true` fixture backend instead.

use std::sync::Arc;

use openengine_cluster_protocol::{
    AgentAttachClosedNotification, AgentAttachEvent, AgentAttachEventNotification,
    AgentAttachParams, BoundedAssistantOutput, ExecutionRef, SubscriptionCloseReason,
    SubscriptionId,
};
use openengine_cluster_server::agent_attach::fixtures::AgentAttachFixtureBackend;
use openengine_cluster_server::agent_attach::AgentAttachStreamItem;
use openengine_cluster_server::{ConnectionContext, Dispatcher};
use serde_json::json;

use crate::agent_attach::InMemoryAgentAttachStore;
use crate::artifacts::{json_artifact, Artifact};

const ROOT: &str = "protocol/openengine-cluster/v1";

pub(crate) async fn generate_agent_attach_goldens() -> Vec<Artifact> {
    vec![
        json_artifact(
            format!("{ROOT}/goldens/agent-attach-session.json"),
            json!(agent_attach_session().await),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/agent_attach/agent-attach-params.json"),
            json!(AgentAttachParams {
                execution: sample_execution_ref(),
            }),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/agent_attach/agent-attach-closed.json"),
            json!([
                AgentAttachClosedNotification {
                    subscription_id: SubscriptionId::new("sub-1"),
                    reason: SubscriptionCloseReason::Done,
                },
                AgentAttachClosedNotification {
                    subscription_id: SubscriptionId::new("sub-2"),
                    reason: SubscriptionCloseReason::SlowConsumer,
                },
            ]),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/agent_attach/agent-attach-event.json"),
            json!([
                AgentAttachEvent::Working {},
                sample_output_event("agent dispatch started"),
                redacted_output_event(),
                AgentAttachEvent::Settled {},
            ]),
        ),
    ]
}

fn sample_execution_ref() -> ExecutionRef {
    ExecutionRef::new("execution-1").expect("fixture execution ref must be valid")
}

fn sample_output_event(text: &str) -> AgentAttachEvent {
    AgentAttachEvent::Output {
        text: BoundedAssistantOutput::new(text).expect("fixture output must be valid"),
    }
}

fn redacted_output_event() -> AgentAttachEvent {
    AgentAttachEvent::Output {
        text: BoundedAssistantOutput::redacted(),
    }
}

/// Establishes an `agent/attach` subscription against a real dispatcher configured with an
/// [`InMemoryAgentAttachStore`], publishes a small deterministic sequence of sample events
/// (including one built via `BoundedAssistantOutput::redacted()`), and returns every
/// `AgentAttachEventNotification` an actual subscriber receives. Reuses
/// [`AgentAttachFixtureBackend`] (the same minimal `agent_attach: true` backend the server crate's
/// own fixture tests exercise) rather than wiring up a second one here.
async fn agent_attach_session() -> Vec<AgentAttachEventNotification> {
    let store = Arc::new(InMemoryAgentAttachStore::default());
    let execution = sample_execution_ref();
    store.register_active(execution.clone()).await;
    let backend = AgentAttachFixtureBackend::new(Arc::clone(&store));
    let dispatcher = Dispatcher::new(backend, ConnectionContext::default());

    let (result, mut stream, _handle) = dispatcher
        .agent_attach(AgentAttachParams {
            execution: execution.clone(),
        })
        .await
        .expect("a backend configured with an agent attach store must support agent_attach");

    store
        .publish(&execution, AgentAttachEvent::Working {})
        .await;
    store
        .publish(&execution, sample_output_event("agent dispatch started"))
        .await;
    store.publish(&execution, redacted_output_event()).await;
    store
        .publish(&execution, AgentAttachEvent::Settled {})
        .await;

    let mut notifications = Vec::new();
    while notifications.len() < 4 {
        match stream.next().await {
            Some(AgentAttachStreamItem::Event(event)) => {
                notifications.push(AgentAttachEventNotification {
                    subscription_id: result.subscription_id.clone(),
                    event,
                });
            }
            _ => break,
        }
    }
    notifications
}
