//! Shared scripted `JsonRpcTransport` used identically by `tests/lifecycle.rs` and
//! `tests/lifecycle_retry.rs` to script a queue of JSON results and record every request sent.

use async_trait::async_trait;
use openengine_cluster_client::{JsonRpcTransport, TransportError};
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::Arc};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct ScriptedTransport {
    pub requests: Arc<Mutex<Vec<Value>>>,
    results: Arc<Mutex<VecDeque<Value>>>,
}

impl ScriptedTransport {
    pub fn new(results: impl IntoIterator<Item = Value>) -> Self {
        Self {
            requests: Arc::new(Mutex::new(Vec::new())),
            results: Arc::new(Mutex::new(results.into_iter().collect())),
        }
    }
}

#[async_trait]
impl JsonRpcTransport for ScriptedTransport {
    async fn request(&self, request: String) -> Result<String, TransportError> {
        let request: Value = serde_json::from_str(&request).unwrap();
        self.requests.lock().await.push(request.clone());
        let result = self.results.lock().await.pop_front().unwrap();
        Ok(json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string())
    }
}
