//! Deterministic in-memory `AgentAttachStore` keyed by `ExecutionRef`. This is a testkit fixture,
//! not a production execution registry: there is no retained history, only live fan-out to every
//! currently registered subscriber for a resolvable execution. Reuses
//! [`openengine_cluster_server::agent_attach::fixtures::AgentAttachFixtureStore`] rather than
//! re-implementing the same in-memory fan-out store a second time.

pub use openengine_cluster_server::agent_attach::fixtures::AgentAttachFixtureStore as InMemoryAgentAttachStore;
