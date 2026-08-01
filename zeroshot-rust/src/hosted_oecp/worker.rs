use std::{collections::BTreeMap, io, process::Stdio, sync::Arc};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
};

use super::credentials::CredentialBundle;

type Pending = Arc<Mutex<BTreeMap<u64, oneshot::Sender<Result<Value, WorkerError>>>>>;

#[derive(Clone, Debug)]
pub struct WorkerError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorkerError {}

pub struct WorkerClient {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    pending: Pending,
    next_id: Mutex<u64>,
}

impl WorkerClient {
    pub async fn spawn(credentials: &CredentialBundle) -> Result<Arc<Self>, WorkerError> {
        credentials
            .prepare_workspace()
            .await
            .map_err(|message| worker_error("WORKSPACE_PREPARATION", message))?;
        let binary = std::env::var("ZEROSHOT_CLUSTER_WORKER_BIN")
            .unwrap_or_else(|_| "zeroshot-cluster-worker".to_owned());
        let mut command = Command::new(binary);
        command
            .current_dir("/workspace/repository")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        credentials.apply_to(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| worker_error("WORKER_START", error.to_string()))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| worker_error("WORKER_START", "worker stdin was unavailable"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| worker_error("WORKER_START", "worker stdout was unavailable"))?;
        let pending = Pending::default();
        tokio::spawn(read_responses(output, Arc::clone(&pending)));
        Ok(Arc::new(Self {
            child: Mutex::new(child),
            input: Mutex::new(input),
            pending,
            next_id: Mutex::new(1),
        }))
    }

    pub async fn start(&self, request: Value) -> Result<Value, WorkerError> {
        self.call("start", json!({ "request": request })).await
    }

    pub async fn result(&self) -> Result<Value, WorkerError> {
        self.call("result", json!({})).await
    }

    pub async fn stop(&self) -> Result<Value, WorkerError> {
        self.call("stop", json!({})).await
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, WorkerError> {
        let id = {
            let mut next = self.next_id.lock().await;
            let id = *next;
            *next = next.saturating_add(1);
            id
        };
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        let frame = serde_json::to_vec(&json!({ "id": id, "method": method, "params": params }))
            .map_err(|error| worker_error("WORKER_PROTOCOL", error.to_string()))?;
        let write = async {
            let mut input = self.input.lock().await;
            input.write_all(&frame).await?;
            input.write_all(b"\n").await?;
            input.flush().await
        }
        .await;
        if let Err(error) = write {
            self.pending.lock().await.remove(&id);
            return Err(worker_error("WORKER_IO", error.to_string()));
        }
        receiver
            .await
            .map_err(|_| worker_error("WORKER_EXITED", "worker response channel closed"))?
    }

    pub async fn terminate(&self) {
        let mut child = self.child.lock().await;
        let _result = child.kill().await;
    }
}

async fn read_responses(output: tokio::process::ChildStdout, pending: Pending) {
    let mut lines = BufReader::new(output).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => route_response(&line, &pending).await,
            Ok(None) | Err(_) => {
                fail_pending(&pending, worker_error("WORKER_EXITED", "worker exited")).await;
                return;
            }
        }
    }
}

async fn route_response(line: &str, pending: &Pending) {
    let Ok(frame) = serde_json::from_str::<Value>(line) else {
        fail_pending(
            pending,
            worker_error("WORKER_PROTOCOL", "worker emitted malformed JSON"),
        )
        .await;
        return;
    };
    if frame.get("type").and_then(Value::as_str) != Some("response") {
        return;
    }
    let Some(id) = frame.get("id").and_then(Value::as_u64) else {
        return;
    };
    let Some(sender) = pending.lock().await.remove(&id) else {
        return;
    };
    let response = if frame.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(frame.get("result").cloned().unwrap_or(Value::Null))
    } else {
        let error = frame.get("error").unwrap_or(&Value::Null);
        Err(WorkerError {
            code: error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("WORKER_ERROR")
                .to_owned(),
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("worker command failed")
                .to_owned(),
        })
    };
    let _result = sender.send(response);
}

async fn fail_pending(pending: &Pending, error: WorkerError) {
    let senders = std::mem::take(&mut *pending.lock().await);
    for sender in senders.into_values() {
        let _result = sender.send(Err(error.clone()));
    }
}

fn worker_error(code: &str, message: impl Into<String>) -> WorkerError {
    WorkerError {
        code: code.to_owned(),
        message: message.into(),
    }
}

impl From<io::Error> for WorkerError {
    fn from(error: io::Error) -> Self {
        worker_error("WORKER_IO", error.to_string())
    }
}
