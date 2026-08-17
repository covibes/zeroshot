use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use openengine_cluster_client::{
    JsonRpcTransport, PumpedSubscription, SubscriptionTransport, TransportError,
};
use openengine_cluster_protocol::{RequestId, SubscriptionId};
use serde_json::json;

use super::super::*;

pub(super) type TempRoot = openengine_cluster_testkit::TemporaryDirectory;

pub(super) fn temp_root() -> TempRoot {
    TempRoot::for_test("zeroshot-native-v2-target")
}

#[derive(Clone, Default)]
pub(super) struct MemoryRegistry {
    targets: Arc<Mutex<BTreeMap<String, TargetRecord>>>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum AuthorityCall {
    Discover(TargetRecord),
    Login(TargetRecord),
    Install(TargetRecord, TargetSetupDocument),
    Session(TargetRecord),
}

#[derive(Clone)]
pub(super) struct FakeAuthority {
    calls: Arc<Mutex<Vec<AuthorityCall>>>,
    endpoint: String,
}

pub(super) struct StubTransport;

#[derive(Clone, Default)]
pub(super) struct FakeDialer {
    pub(super) sessions: Arc<Mutex<Vec<(TargetRecord, String)>>>,
}

impl TargetRegistry for MemoryRegistry {
    fn insert(&self, target: TargetRecord) -> Result<(), TargetConnectorError> {
        let mut targets = self.targets.lock().assert_value();
        if targets.contains_key(&target.name) {
            return Err(TargetConnectorError::AlreadyExists(target.name));
        }
        targets.insert(target.name.clone(), target);
        Ok(())
    }

    fn get(&self, name: &str) -> Result<TargetRecord, TargetConnectorError> {
        self.targets
            .lock()
            .assert_value()
            .get(name)
            .cloned()
            .ok_or_else(|| TargetConnectorError::NotFound(name.to_owned()))
    }
}

impl FakeAuthority {
    pub(super) fn new(endpoint: impl Into<String>) -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            endpoint: endpoint.into(),
        }
    }

    pub(super) fn calls(&self) -> Vec<AuthorityCall> {
        self.calls.lock().assert_value().clone()
    }
}

#[async_trait]
impl TargetControlAuthority for FakeAuthority {
    async fn discover(&self, target: &TargetRecord) -> Result<(), TargetAuthorityError> {
        self.calls
            .lock()
            .assert_value()
            .push(AuthorityCall::Discover(target.clone()));
        Ok(())
    }

    async fn login(&self, target: &TargetRecord) -> Result<(), TargetAuthorityError> {
        self.calls
            .lock()
            .assert_value()
            .push(AuthorityCall::Login(target.clone()));
        Ok(())
    }

    async fn install(
        &self,
        target: &TargetRecord,
        setup: &TargetSetupDocument,
    ) -> Result<(), TargetAuthorityError> {
        self.calls
            .lock()
            .assert_value()
            .push(AuthorityCall::Install(target.clone(), setup.clone()));
        Ok(())
    }

    async fn oecp_session(
        &self,
        target: &TargetRecord,
    ) -> Result<AuthenticatedTargetOecp, TargetAuthorityError> {
        self.calls
            .lock()
            .assert_value()
            .push(AuthorityCall::Session(target.clone()));
        AuthenticatedTargetOecp::new(self.endpoint.clone(), "access-token")
            .map_err(|error| TargetAuthorityError::new(error.to_string()))
    }
}

#[async_trait]
impl JsonRpcTransport for StubTransport {
    async fn request(&self, _request: String) -> Result<String, TransportError> {
        Err(TransportError::Protocol("unused test transport".to_owned()))
    }
}

#[async_trait]
impl SubscriptionTransport for StubTransport {
    async fn open_subscription(
        &self,
        _request: String,
        _id: RequestId,
    ) -> Result<(String, Option<PumpedSubscription>), TransportError> {
        Err(TransportError::Protocol("unused test transport".to_owned()))
    }

    async fn cancel_subscription(&self, _id: SubscriptionId) -> Result<(), TransportError> {
        Ok(())
    }

    async fn cancel_request(&self, _id: RequestId) -> Result<(), TransportError> {
        Ok(())
    }

    fn next_watch_request_id(&self) -> RequestId {
        RequestId::String("test-watch".to_owned())
    }
}

#[async_trait]
impl TargetOecpDialer for FakeDialer {
    type Transport = StubTransport;

    async fn dial(
        &self,
        target: &TargetRecord,
        session: AuthenticatedTargetOecp,
    ) -> Result<Arc<Self::Transport>, TargetConnectorError> {
        self.sessions
            .lock()
            .assert_value()
            .push((target.clone(), session.endpoint().to_owned()));
        Ok(Arc::new(StubTransport))
    }
}

pub(super) fn target() -> TargetRecord {
    TargetRecord {
        id: "11111111-1111-4111-8111-111111111111".to_owned(),
        name: "prod".to_owned(),
        origin: "https://target.example".to_owned(),
        device_token: "22222222-2222-4222-8222-222222222222".to_owned(),
    }
}

pub(super) fn runtime_json() -> serde_json::Value {
    json!({
        "harness":"codex",
        "provider":"openai",
        "nodes":{
            "worker":{
                "kind":"agent",
                "model":"gpt-5.6",
                "env":["OPENAI_API_KEY"]
            }
        }
    })
}

pub(super) fn runtime_file(root: &TempRoot) -> PathBuf {
    let path = root.path("runtime.json");
    std::fs::write(&path, serde_json::to_vec(&runtime_json()).assert_value()).assert_value();
    path
}

pub(super) fn setup_request(path: PathBuf) -> TargetSetup {
    TargetSetup {
        name: "prod".to_owned(),
        repository: "open-engine/zeroshot".to_owned(),
        runtime_config: path,
        base: Some("main".to_owned()),
        target_branch: None,
    }
}

use openengine_cluster_testkit::assertions::{AssertValue};
