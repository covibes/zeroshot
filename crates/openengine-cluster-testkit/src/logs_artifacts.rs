//! Generated `logs` golden fixtures. `logs-session.json` is produced by driving a real
//! `AdmissionCoordinator` configured with an `InMemoryLogStore` through a `logs` subscription and
//! recording every event an actual subscriber receives; the remaining fixtures document standalone
//! wire shapes for request/close framing that no single session exercises.

use std::sync::Arc;

use openengine_cluster_protocol::{
    BoundedLogMessage, BoundedLogTarget, LogEventNotification, LogLevel, LogRecord,
    LogsClosedNotification, LogsParams, SubscriptionCloseReason, SubscriptionId,
};
use openengine_cluster_server::admission::AdmissionCoordinator;
use openengine_cluster_server::logs::{LogStore, LogStreamItem};
use openengine_cluster_server::{ConnectionContext, Dispatcher};
use serde_json::json;

use crate::admission::{InMemoryAdmissionStore, ScriptedVerifier};
use crate::artifacts::{json_artifact, Artifact};
use crate::logs::InMemoryLogStore;

const ROOT: &str = "protocol/openengine-cluster/v1";

pub(crate) async fn generate_logs_goldens() -> Vec<Artifact> {
    vec![
        json_artifact(
            format!("{ROOT}/goldens/logs-session.json"),
            json!(logs_session().await),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/logs/logs-params.json"),
            json!(LogsParams::default()),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/logs/logs-closed.json"),
            json!([
                LogsClosedNotification {
                    subscription_id: SubscriptionId::new("sub-1"),
                    reason: SubscriptionCloseReason::Done,
                },
                LogsClosedNotification {
                    subscription_id: SubscriptionId::new("sub-2"),
                    reason: SubscriptionCloseReason::SlowConsumer,
                },
            ]),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/logs/log-record.json"),
            json!([
                sample_log_record(LogLevel::Trace, "trace record"),
                sample_log_record(LogLevel::Debug, "debug record"),
                sample_log_record(LogLevel::Info, "info record"),
                sample_log_record(LogLevel::Warn, "warn record"),
                sample_log_record(LogLevel::Error, "error record"),
                redacted_log_record(),
            ]),
        ),
    ]
}

fn sample_log_record(level: LogLevel, message: &str) -> LogRecord {
    LogRecord {
        level,
        target: BoundedLogTarget::new("worker-dispatch").expect("fixture target must be valid"),
        message: BoundedLogMessage::new(message).expect("fixture message must be valid"),
    }
}

fn redacted_log_record() -> LogRecord {
    LogRecord {
        level: LogLevel::Error,
        target: BoundedLogTarget::new("worker-dispatch").expect("fixture target must be valid"),
        message: BoundedLogMessage::redacted(),
    }
}

/// Establishes a `logs` subscription against a real `AdmissionCoordinator` configured with an
/// `InMemoryLogStore`, publishes a small deterministic sequence of sample records (including one
/// built via `BoundedLogMessage::redacted()`), and returns every `LogEventNotification` an actual
/// subscriber receives.
async fn logs_session() -> Vec<LogEventNotification> {
    let store = Arc::new(InMemoryLogStore::default());
    let backend = AdmissionCoordinator::new(
        ScriptedVerifier::new(vec![]),
        InMemoryAdmissionStore::default(),
    )
    .with_log_store(Arc::clone(&store) as Arc<dyn LogStore>);
    let dispatcher = Dispatcher::new(backend, ConnectionContext::default());

    let (result, mut stream, _handle) = dispatcher
        .logs(LogsParams::default())
        .await
        .expect("a backend configured with a log store must support logs");

    store
        .publish(sample_log_record(LogLevel::Info, "worker dispatch started"))
        .await;
    store
        .publish(sample_log_record(LogLevel::Warn, "retrying after backoff"))
        .await;
    store.publish(redacted_log_record()).await;

    let mut notifications = Vec::new();
    while notifications.len() < 3 {
        match stream.next().await {
            Some(LogStreamItem::Record(record)) => {
                notifications.push(LogEventNotification {
                    subscription_id: result.subscription_id.clone(),
                    record,
                });
            }
            _ => break,
        }
    }
    notifications
}
