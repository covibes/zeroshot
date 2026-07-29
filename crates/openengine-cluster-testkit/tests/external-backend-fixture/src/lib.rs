#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use async_trait::async_trait;
    use openengine_cluster_protocol::{
        ClusterStatus, GetParams, GetResult, GraphProfile, GraphProfileSet, InitializeParams,
        InitializeResult, ServerCapabilities, SubscriptionId, WatchParams, WatchResult,
    };
    use openengine_cluster_server::watch::{
        subscribe_and_stream, ObservationStore, SubscribeAndStreamRequest, WatchEventStream,
        WatchHandle,
    };
    use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
    use openengine_cluster_testkit::admission::InMemoryAdmissionStore;
    use openengine_cluster_testkit::conformance::{
        conformance_catalog, BackendRegistration, RegisteredOptionalCapabilities,
    };
    use openengine_cluster_testkit::{run_backend_conformance, BackendFactory};

    #[derive(Default)]
    struct LifecycleCounts {
        creates: AtomicUsize,
        resets: AtomicUsize,
        cleanups: AtomicUsize,
        calls: AtomicUsize,
    }

    #[derive(Clone)]
    struct ExternalMinimalBackend {
        observations: Arc<InMemoryAdmissionStore>,
        counts: Arc<LifecycleCounts>,
    }

    #[async_trait]
    impl ClusterBackend for ExternalMinimalBackend {
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
                    "runner did not supply its isolated context",
                ));
            }
            self.counts.calls.fetch_add(1, Ordering::SeqCst);
            Ok(InitializeResult::new(
                ServerCapabilities {
                    graph_profiles: GraphProfileSet::new(vec![]).unwrap(),
                    logs: false,
                    agent_attach: false,
                },
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
            self.counts.calls.fetch_add(1, Ordering::SeqCst);
            Ok(GetResult {
                spec: None,
                status: ClusterStatus::empty(),
                at_cursor: None,
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
                    subscription_id: SubscriptionId::new("external-portable-watch"),
                    params,
                    queue_capacity,
                },
                |error| BackendError::new("WATCH_STORE", error.to_string()),
            )
            .await
        }
    }

    struct ExternalFactory {
        profiles: Vec<GraphProfile>,
        counts: Arc<LifecycleCounts>,
    }

    #[async_trait]
    impl BackendFactory for ExternalFactory {
        type Backend = ExternalMinimalBackend;
        type Error = Infallible;

        fn registration(&self) -> BackendRegistration<'_> {
            BackendRegistration {
                graph_profiles: &self.profiles,
                optional: RegisteredOptionalCapabilities::default(),
            }
        }

        async fn create(&self) -> Result<Self::Backend, Self::Error> {
            self.counts.creates.fetch_add(1, Ordering::SeqCst);
            Ok(ExternalMinimalBackend {
                observations: Arc::new(InMemoryAdmissionStore::default()),
                counts: Arc::clone(&self.counts),
            })
        }

        async fn reset(&self, _backend: &Self::Backend) -> Result<(), Self::Error> {
            self.counts.resets.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn cleanup(&self, _backend: Self::Backend) -> Result<(), Self::Error> {
            self.counts.cleanups.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn external_crate_runs_the_immutable_portable_catalog() {
        let counts = Arc::new(LifecycleCounts::default());
        let factory = ExternalFactory {
            profiles: vec![],
            counts: Arc::clone(&counts),
        };
        let report = run_backend_conformance(&factory).await.unwrap();

        assert_eq!(report.cases().len(), conformance_catalog().len());
        assert_eq!(report.passed(), 16);
        assert_eq!(report.skipped(), 2);
        assert_eq!(counts.creates.load(Ordering::SeqCst), report.passed());
        assert_eq!(counts.resets.load(Ordering::SeqCst), report.passed());
        assert_eq!(counts.cleanups.load(Ordering::SeqCst), report.passed());
        assert!(counts.calls.load(Ordering::SeqCst) > 0);
    }
}
