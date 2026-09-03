use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use openengine_cluster_client::{
    JsonRpcTransport, PumpedSubscription, SubscriptionTransport, TransportError,
};
use openengine_cluster_protocol::{
    RequestId, RunForceParams, RunId, RunListParams, RunLogEventNotification, RunLogsParams,
    ResolvedSource, RunStatusParams, RunSubmitResult, RunWatchParams, SourceBranchId,
    SourceRepositoryId, SourceRevisionId, SubscriptionId, TargetOecpSessionRequest,
};
use serde_json::json;
use zeroshot_engine::native_v2_cli::{PreparedRunRequest, TargetRunIntent};

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
    Submit(TargetRecord, Box<TargetRunRequest>),
    Session(TargetRecord, TargetOecpSessionRequest),
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

    fn setup(
        &self,
        name: &str,
        repository: String,
        default_branch: Option<String>,
    ) -> Result<(), TargetConnectorError> {
        let mut targets = self.targets.lock().assert_value();
        let target = targets
            .get_mut(name)
            .ok_or_else(|| TargetConnectorError::NotFound(name.to_owned()))?;
        target.repository = Some(repository);
        target.default_branch = default_branch;
        Ok(())
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

    async fn submit(
        &self,
        target: &TargetRecord,
        request: &TargetRunRequest,
    ) -> Result<RunSubmitResult, TargetAuthorityError> {
        self.calls.lock().assert_value().push(AuthorityCall::Submit(
            target.clone(),
            Box::new(request.clone()),
        ));
        Ok(RunSubmitResult {
            run_id: request.run_id.clone(),
        })
    }

    async fn oecp_session(
        &self,
        target: &TargetRecord,
        request: &TargetOecpSessionRequest,
    ) -> Result<TargetOecpAccess, TargetAuthorityError> {
        self.calls
            .lock()
            .assert_value()
            .push(AuthorityCall::Session(target.clone(), request.clone()));
        TargetOecpAccess::new(
            self.endpoint.clone(),
            Some("access-token".to_owned()),
            &target.access,
        )
        .map_err(|error| TargetAuthorityError::new(error.to_string()))
    }

    async fn connection_list(
        &self,
        _target: &TargetRecord,
        _request: ConnectionListRequest,
    ) -> Result<ConnectionListResult, TargetAuthorityError> {
        Err(TargetAuthorityError::new(
            "fake connection management is unavailable",
        ))
    }

    async fn connection_set(
        &self,
        _target: &TargetRecord,
        _request: ConnectionSetRequest,
    ) -> Result<ConnectionMutationResult, TargetAuthorityError> {
        Err(TargetAuthorityError::new(
            "fake connection management is unavailable",
        ))
    }

    async fn connection_delete(
        &self,
        _target: &TargetRecord,
        _request: ConnectionDeleteRequest,
    ) -> Result<ConnectionDeleteResult, TargetAuthorityError> {
        Err(TargetAuthorityError::new(
            "fake connection management is unavailable",
        ))
    }

    async fn hosted_run_list(
        &self,
        _target: &TargetRecord,
        _params: RunListParams,
    ) -> Result<CliRunListResult, TargetAuthorityError> {
        Err(TargetAuthorityError::new(
            "fake hosted lifecycle is unavailable",
        ))
    }

    async fn hosted_run_status(
        &self,
        _target: &TargetRecord,
        _params: RunStatusParams,
    ) -> Result<CliRunStatusResult, TargetAuthorityError> {
        Err(TargetAuthorityError::new(
            "fake hosted lifecycle is unavailable",
        ))
    }

    async fn hosted_run_watch(
        &self,
        _target: &TargetRecord,
        _params: RunWatchParams,
    ) -> Result<BoxedSubscription<CliRunWatchEventNotification>, TargetAuthorityError> {
        Err(TargetAuthorityError::new(
            "fake hosted lifecycle is unavailable",
        ))
    }

    async fn hosted_run_logs(
        &self,
        _target: &TargetRecord,
        _params: RunLogsParams,
    ) -> Result<BoxedSubscription<RunLogEventNotification>, TargetAuthorityError> {
        Err(TargetAuthorityError::new(
            "fake hosted lifecycle is unavailable",
        ))
    }

    async fn hosted_run_force(
        &self,
        _target: &TargetRecord,
        _params: RunForceParams,
    ) -> Result<CliRunForceResult, TargetAuthorityError> {
        Err(TargetAuthorityError::new(
            "fake hosted lifecycle is unavailable",
        ))
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
        session: TargetOecpAccess,
    ) -> Result<Arc<Self::Transport>, TargetConnectorError> {
        self.sessions
            .lock()
            .assert_value()
            .push((target.clone(), session.endpoint().to_owned()));
        Ok(Arc::new(StubTransport))
    }
}

pub(super) fn target() -> TargetRecord {
    hosted_target("prod", "https://target.example")
}

pub(super) fn hosted_target(name: &str, origin: impl Into<String>) -> TargetRecord {
    TargetRecord {
        id: "11111111-1111-4111-8111-111111111111".to_owned(),
        name: name.to_owned(),
        origin: origin.into(),
        access: TargetAccess::Hosted {
            device_token: "22222222-2222-4222-8222-222222222222".to_owned(),
        },
        repository: Some("open-engine/zeroshot".to_owned()),
        default_branch: Some("main".to_owned()),
    }
}

pub(super) fn direct_target(origin: impl Into<String>) -> TargetRecord {
    TargetRecord {
        id: "11111111-1111-4111-8111-111111111111".to_owned(),
        name: "vm".to_owned(),
        origin: origin.into(),
        access: TargetAccess::Direct,
        repository: Some("open-engine/zeroshot".to_owned()),
        default_branch: Some("main".to_owned()),
    }
}

pub(super) fn setup_request() -> TargetSetup {
    TargetSetup {
        name: "prod".to_owned(),
        repository: "open-engine/zeroshot".to_owned(),
        default_branch: Some(SourceBranchId::new("main").assert_value()),
    }
}

pub(super) fn run_intent() -> TargetRunIntent {
    serde_json::from_value(json!({
        "title":"Repair checkout",
        "graph":{
            "profile":"openengine.graph.full/v1",
            "initialInput":{"kind":"null"},
            "policy":{"policy":"policy.native-v2@1","default":"deny"},
            "root":{"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
        },
        "initialInput":null,
        "runtime":{
            "harness":"codex",
            "provider":"openai",
            "size":"medium",
            "nodes":{}
        },
        "branch":"feature",
        "submissionKey":"target-test"
    }))
    .assert_value()
}

pub(super) fn run_request() -> PreparedRunRequest {
    PreparedRunRequest {
        run_id: RunId::new("018f5e78-7f95-7c22-8d98-3f15af20c991"),
        intent: run_intent(),
        connections: BTreeMap::new(),
        github_token: None,
        profile: None,
    }
}

pub(super) fn exact_run_request() -> TargetRunRequest {
    let request = run_request();
    TargetRunRequest {
        run_id: request.run_id,
        submission: openengine_cluster_protocol::RunSubmission {
            title: request.intent.title,
            graph: request.intent.graph,
            initial_input: request.intent.initial_input,
            runtime: request.intent.runtime,
            source: ResolvedSource {
                repository: SourceRepositoryId::new("open-engine/zeroshot").assert_value(),
                branch: SourceBranchId::new("feature").assert_value(),
                revision: SourceRevisionId::new("0123456789abcdef0123456789abcdef01234567")
                    .assert_value(),
            },
            submission_key: request.intent.submission_key,
        },
        connections: request.connections,
        connection_resolver: None,
        github_token: request.github_token,
    }
}

#[derive(Clone, Copy)]
pub(super) struct FakeSourceResolver;

#[async_trait]
impl TargetSourceResolver for FakeSourceResolver {
    async fn resolve(
        &self,
        repository: &str,
        branch: Option<&str>,
        _github_token: Option<&str>,
    ) -> Result<ResolvedSource, TargetConnectorError> {
        Ok(ResolvedSource {
            repository: SourceRepositoryId::new(repository)
                .map_err(|_| TargetConnectorError::SourceResolution)?,
            branch: SourceBranchId::new(branch.unwrap_or("remote-default"))
                .map_err(|_| TargetConnectorError::SourceResolution)?,
            revision: SourceRevisionId::new("0123456789abcdef0123456789abcdef01234567")
                .map_err(|_| TargetConnectorError::SourceResolution)?,
        })
    }
}

use openengine_cluster_testkit::assertions::{AssertValue};
