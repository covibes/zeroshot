use std::convert::Infallible;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    AgentAttachParams, AgentAttachResult, ClusterStatus, GetParams, GetResult, GraphProfile,
    GraphProfileSet, InitializeParams, InitializeResult, LogsParams, LogsResult,
    ServerCapabilities, SubscriptionId, WatchParams, WatchResult,
};
use openengine_cluster_server::agent_attach::{
    default_agent_attach_error_mapping, subscribe_and_stream_agent_attach, AgentAttachEventStream,
    AgentAttachHandle, AgentAttachStore, SubscribeAndStreamAgentAttachRequest,
};
use openengine_cluster_server::logs::{subscribe_and_stream_logs, LogEventStream, LogStore, LogsHandle};
use openengine_cluster_server::watch::{
    subscribe_and_stream, ObservationStore, SubscribeAndStreamRequest, WatchEventStream,
    WatchHandle,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use openengine_cluster_testkit::admission::InMemoryAdmissionStore;
use openengine_cluster_testkit::agent_attach::InMemoryAgentAttachStore;
use openengine_cluster_testkit::conformance::{
    conformance_catalog, BackendRegistration, CaseDisposition, ConformanceModule,
    RegisteredOptionalCapabilities,
};
use openengine_cluster_testkit::logs::InMemoryLogStore;
use openengine_cluster_testkit::{run_backend_conformance, BackendFactory};
use openengine_cluster_testkit::fixture::{dispatcher_fixture, FixtureBackend};

#[derive(Clone)]
struct OptionalCapabilityBackend {
    capabilities: ServerCapabilities,
    observations: Arc<InMemoryAdmissionStore>,
    logs: Arc<InMemoryLogStore>,
    agent_attach: Arc<InMemoryAgentAttachStore>,
}

#[async_trait]
impl ClusterBackend for OptionalCapabilityBackend {
    async fn initialize(
        &self,
        context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        if !context
            .identity()
            .tenant()
            .as_str()
            .starts_with("portable-conformance:")
        {
            return Err(BackendError::new(
                "CONTEXT_NOT_ISOLATED",
                "runner context was missing",
            ));
        }
        Ok(InitializeResult::new(
            self.capabilities.clone(),
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        if !context
            .identity()
            .tenant()
            .as_str()
            .starts_with("portable-conformance:")
        {
            return Err(BackendError::new(
                "CONTEXT_NOT_ISOLATED",
                "runner context was missing",
            ));
        }
        Ok(GetResult {
            spec: None,
            status: ClusterStatus::empty(),
            at_cursor: None,
            terminal_result: None,
        })
    }

    async fn watch(
        &self,
        _context: &ConnectionContext,
        params: WatchParams,
        queue_capacity: usize,
    ) -> Result<(WatchResult, WatchEventStream, WatchHandle), BackendError> {
        let store: Arc<dyn ObservationStore> = self.observations.clone();
        subscribe_and_stream(
            &store,
            SubscribeAndStreamRequest {
                subscription_id: SubscriptionId::new("portable-watch"),
                params,
                queue_capacity,
            },
            |error| BackendError::new("WATCH_STORE", error.to_string()),
        )
        .await
    }

    async fn logs(
        &self,
        _context: &ConnectionContext,
        _params: LogsParams,
        queue_capacity: usize,
    ) -> Result<(LogsResult, LogEventStream, LogsHandle), BackendError> {
        let store: Arc<dyn LogStore> = self.logs.clone();
        Ok(
            subscribe_and_stream_logs(&store, SubscriptionId::new("portable-logs"), queue_capacity)
                .await,
        )
    }

    async fn agent_attach(
        &self,
        _context: &ConnectionContext,
        params: AgentAttachParams,
        queue_capacity: usize,
    ) -> Result<(AgentAttachResult, AgentAttachEventStream, AgentAttachHandle), BackendError> {
        let store: Arc<dyn AgentAttachStore> = self.agent_attach.clone();
        subscribe_and_stream_agent_attach(
            &store,
            SubscribeAndStreamAgentAttachRequest {
                execution: params.execution,
                subscription_id: SubscriptionId::new("portable-agent-attach"),
                queue_capacity,
            },
            default_agent_attach_error_mapping,
        )
        .await
    }
}

struct ScriptedBackendFactory {
    registered_profiles: Vec<GraphProfile>,
    creates: AtomicUsize,
    resets: AtomicUsize,
    cleanups: AtomicUsize,
}

impl ScriptedBackendFactory {
    fn new(profiles: Vec<GraphProfile>) -> Self {
        Self {
            registered_profiles: profiles,
            creates: AtomicUsize::new(0),
            resets: AtomicUsize::new(0),
            cleanups: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl BackendFactory for ScriptedBackendFactory {
    type Backend = FixtureBackend;
    type Error = Infallible;

    fn registration(&self) -> BackendRegistration<'_> {
        BackendRegistration {
            graph_profiles: &self.registered_profiles,
            optional: RegisteredOptionalCapabilities::default(),
        }
    }

    async fn create(&self) -> Result<Self::Backend, Self::Error> {
        self.creates.fetch_add(1, Ordering::SeqCst);
        let (_client, _dispatcher, backend, _verifier, _store) = dispatcher_fixture(vec![]);
        Ok(backend)
    }

    async fn reset(&self, _backend: &Self::Backend) -> Result<(), Self::Error> {
        self.resets.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn cleanup(&self, _backend: Self::Backend) -> Result<(), Self::Error> {
        self.cleanups.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct ReorderedProfileFactory;

#[async_trait]
impl BackendFactory for ReorderedProfileFactory {
    type Backend = OptionalCapabilityBackend;
    type Error = Infallible;

    fn registration(&self) -> BackendRegistration<'_> {
        BackendRegistration {
            graph_profiles: &[GraphProfile::SingleWorker, GraphProfile::Full],
            optional: RegisteredOptionalCapabilities::default(),
        }
    }

    async fn create(&self) -> Result<Self::Backend, Self::Error> {
        Ok(OptionalCapabilityBackend {
            capabilities: ServerCapabilities {
                graph_profiles: GraphProfileSet::new(vec![
                    GraphProfile::Full,
                    GraphProfile::SingleWorker,
                ])
                .unwrap(),
                logs: false,
                agent_attach: false,
            },
            observations: Arc::new(InMemoryAdmissionStore::default()),
            logs: Arc::new(InMemoryLogStore::default()),
            agent_attach: Arc::new(InMemoryAgentAttachStore::default()),
        })
    }

    async fn reset(&self, _backend: &Self::Backend) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn cleanup(&self, _backend: Self::Backend) -> Result<(), Self::Error> {
        Ok(())
    }
}

struct OptionalCapabilityFactory;

#[async_trait]
impl BackendFactory for OptionalCapabilityFactory {
    type Backend = OptionalCapabilityBackend;
    type Error = Infallible;

    fn registration(&self) -> BackendRegistration<'_> {
        BackendRegistration {
            graph_profiles: &[],
            optional: RegisteredOptionalCapabilities {
                logs: true,
                agent_attach: true,
            },
        }
    }

    async fn create(&self) -> Result<Self::Backend, Self::Error> {
        Ok(OptionalCapabilityBackend {
            capabilities: ServerCapabilities {
                graph_profiles: GraphProfileSet::new(vec![]).unwrap(),
                logs: true,
                agent_attach: true,
            },
            observations: Arc::new(InMemoryAdmissionStore::default()),
            logs: Arc::new(InMemoryLogStore::default()),
            agent_attach: Arc::new(InMemoryAgentAttachStore::default()),
        })
    }

    async fn reset(&self, _backend: &Self::Backend) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn cleanup(&self, _backend: Self::Backend) -> Result<(), Self::Error> {
        Ok(())
    }
}

struct NonCloneBackend(OptionalCapabilityBackend);

#[async_trait]
impl ClusterBackend for NonCloneBackend {
    async fn initialize(
        &self,
        context: &ConnectionContext,
        params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        self.0.initialize(context, params).await
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError> {
        self.0.get(context, params).await
    }

    async fn watch(
        &self,
        context: &ConnectionContext,
        params: WatchParams,
        queue_capacity: usize,
    ) -> Result<(WatchResult, WatchEventStream, WatchHandle), BackendError> {
        self.0.watch(context, params, queue_capacity).await
    }
}

struct NonCloneFactory;

#[async_trait]
impl BackendFactory for NonCloneFactory {
    type Backend = NonCloneBackend;
    type Error = Infallible;

    fn registration(&self) -> BackendRegistration<'_> {
        BackendRegistration {
            graph_profiles: &[],
            optional: RegisteredOptionalCapabilities::default(),
        }
    }

    async fn create(&self) -> Result<Self::Backend, Self::Error> {
        Ok(NonCloneBackend(OptionalCapabilityBackend {
            capabilities: ServerCapabilities {
                graph_profiles: GraphProfileSet::new(vec![]).unwrap(),
                logs: false,
                agent_attach: false,
            },
            observations: Arc::new(InMemoryAdmissionStore::default()),
            logs: Arc::new(InMemoryLogStore::default()),
            agent_attach: Arc::new(InMemoryAgentAttachStore::default()),
        }))
    }

    async fn reset(&self, _backend: &Self::Backend) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn cleanup(&self, _backend: Self::Backend) -> Result<(), Self::Error> {
        Ok(())
    }
}

#[tokio::test]
async fn runner_uses_the_exact_non_clone_backend_for_dispatch_reset_and_cleanup() {
    let report = run_backend_conformance(&NonCloneFactory).await.unwrap();
    assert_eq!(report.passed(), 16);
    assert_eq!(report.skipped(), 2);
}

#[tokio::test]
async fn scripted_backend_factory_runs_every_portable_required_case() {
    let factory = ScriptedBackendFactory::new(vec![]);
    let report = run_backend_conformance(&factory).await.unwrap();

    assert_eq!(report.cases().len(), conformance_catalog().len());
    assert_eq!(report.passed(), 16);
    assert_eq!(report.skipped(), 2);
    assert_eq!(factory.creates.load(Ordering::SeqCst), report.passed());
    assert_eq!(factory.resets.load(Ordering::SeqCst), report.passed());
    assert_eq!(factory.cleanups.load(Ordering::SeqCst), report.passed());
}

#[tokio::test]
async fn graph_profile_registration_order_is_semantic() {
    let report = run_backend_conformance(&ReorderedProfileFactory)
        .await
        .unwrap();

    assert_eq!(report.passed(), 16);
    assert_eq!(report.skipped(), 2);
}

#[tokio::test]
async fn graph_profile_mismatch_fails_but_still_resets_and_cleans() {
    let factory = ScriptedBackendFactory::new(vec![GraphProfile::SingleWorker]);
    let failures = run_backend_conformance(&factory).await.unwrap_err();

    assert!(
        failures
            .failures()
            .iter()
            .any(|failure| failure.message().contains("did not match registration"))
    );
    assert_eq!(
        failures.cases().len() + failures.failures().len(),
        conformance_catalog().len()
    );
    assert_eq!(failures.passed(), 15);
    assert_eq!(failures.skipped(), 2);
    assert_eq!(
        factory.creates.load(Ordering::SeqCst),
        factory.resets.load(Ordering::SeqCst)
    );
    assert_eq!(
        factory.creates.load(Ordering::SeqCst),
        factory.cleanups.load(Ordering::SeqCst)
    );
}

#[tokio::test]
async fn advertised_optional_modules_execute_and_unadvertised_modules_only_skip_themselves() {
    let disabled = ScriptedBackendFactory::new(vec![]);
    let disabled_report = run_backend_conformance(&disabled).await.unwrap();
    let skipped: Vec<_> = disabled_report
        .cases()
        .iter()
        .filter(|case| matches!(case.disposition(), CaseDisposition::Skipped(_)))
        .map(|case| case.id())
        .collect();
    assert_eq!(
        skipped,
        ["portable.logs.establish", "portable.agent-attach.unknown"]
    );

    let enabled = OptionalCapabilityFactory;
    let enabled_report = run_backend_conformance(&enabled).await.unwrap();
    assert_eq!(enabled_report.passed(), conformance_catalog().len());
    assert_eq!(enabled_report.skipped(), 0);
}

#[test]
fn transport_applicability_matches_each_portable_probe_surface() {
    for case in conformance_catalog() {
        let applicability = case.transport_applicability();
        assert!(applicability.ndjson, "{}", case.id());
        assert!(applicability.websocket, "{}", case.id());
        match case.module() {
            ConformanceModule::Initialize | ConformanceModule::Get => {
                assert!(applicability.dispatcher, "{}", case.id());
                assert!(applicability.typed_in_process, "{}", case.id());
            }
            ConformanceModule::Dispatch
            | ConformanceModule::Admission
            | ConformanceModule::Lifecycle => {
                assert!(applicability.dispatcher, "{}", case.id());
                assert!(!applicability.typed_in_process, "{}", case.id());
            }
            ConformanceModule::Watch | ConformanceModule::Logs | ConformanceModule::AgentAttach => {
                assert!(!applicability.dispatcher, "{}", case.id());
                assert!(applicability.typed_in_process, "{}", case.id());
                let request: serde_json::Value = serde_json::from_str(case.input()).unwrap();
                assert_eq!(request["jsonrpc"], "2.0", "{}", case.id());
                assert!(request["method"].is_string(), "{}", case.id());
                assert!(request["params"].is_object(), "{}", case.id());
            }
        }
    }
}

#[tokio::test]
#[ignore = "manual portable backend stress/load target"]
async fn portable_backend_conformance_stress_load() {
    let factory = ScriptedBackendFactory::new(vec![]);
    for _ in 0..100 {
        run_backend_conformance(&factory).await.unwrap();
    }
}
