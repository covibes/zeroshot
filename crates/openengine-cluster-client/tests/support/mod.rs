use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_client::{JsonRpcTransport, TransportError};
use serde_json::{json, Value};
use tokio::sync::Mutex;

pub use openengine_cluster_testkit::assertions::{AssertAt, AssertError, AssertSlice, AssertValue};

pub trait JsonAt {
    fn assert_key(&self, key: &str) -> &Value;
}

impl JsonAt for Value {
    fn assert_key(&self, key: &str) -> &Value {
        self.get(key)
            .assert_value_with("expected JSON object field")
    }
}

#[derive(Clone)]
pub struct RecordingTransport {
    methods: Arc<Mutex<Vec<String>>>,
    response: fn(&str) -> Value,
}

impl RecordingTransport {
    pub fn new(response: fn(&str) -> Value) -> Self {
        Self {
            methods: Arc::default(),
            response,
        }
    }

    pub async fn methods(&self) -> Vec<String> {
        self.methods.lock().await.clone()
    }
}

#[async_trait]
impl JsonRpcTransport for RecordingTransport {
    async fn request(&self, request: String) -> Result<String, TransportError> {
        let request: Value = serde_json::from_str(&request)
            .map_err(|error| TransportError::Protocol(error.to_string()))?;
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| TransportError::Protocol("request method is missing".to_owned()))?
            .to_owned();
        self.methods.lock().await.push(method.clone());
        Ok(json!({
            "jsonrpc": "2.0",
            "id": request.get("id").cloned().unwrap_or(Value::Null),
            "result": (self.response)(&method),
        })
        .to_string())
    }
}
