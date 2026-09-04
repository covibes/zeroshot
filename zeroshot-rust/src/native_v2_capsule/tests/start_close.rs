use std::{future::Future, sync::Arc, time::Duration};

use openengine_cluster_protocol::TokenCount;
use tokio::{sync::Notify, task::JoinHandle};

use super::super::StartReadinessPause;
use crate::native_v2_contract::TokenUsageDelta;
use openengine_cluster_testkit::assertions::AssertValue;

#[derive(Clone, Default)]
struct Gate {
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

impl Gate {
    async fn enter(&self) {
        self.entered.notify_one();
        self.release.notified().await;
    }

    async fn wait(&self) {
        self.entered.notified().await;
    }

    fn open(&self) {
        self.release.notify_one();
    }
}

async fn within_one_second<F>(future: F) -> F::Output
where
    F: Future,
{
    tokio::time::timeout(Duration::from_secs(1), future)
        .await
        .assert_value()
}

async fn join_test_task<T>(task: JoinHandle<T>) -> T {
    within_one_second(task).await.assert_value()
}

async fn spawn_at_readiness<F>(
    future: F,
    gate: &Gate,
    pause: &StartReadinessPause,
) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let task = tokio::spawn(future);
    gate.wait().await;
    gate.open();
    within_one_second(pause.wait_until_sent()).await;
    task
}

fn token_usage() -> TokenUsageDelta {
    TokenUsageDelta {
        input_tokens: TokenCount::new(3).assert_value(),
        output_tokens: TokenCount::new(2).assert_value(),
        cache_read_input_tokens: None,
        cache_creation_input_tokens: None,
    }
}

#[path = "start_close/endpoint.rs"]
mod endpoint;
#[path = "start_close/remote.rs"]
mod remote;
