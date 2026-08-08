//! Unpublished, single-run OECP capsule runtime for the bounded legacy Node worker.
//!
//! The runtime owns process containment and protocol state. Trusted capsule-agent services own
//! workspace preparation, proxy credential cleanup, and Git delivery through the closed ports in
//! [`ports`]. No native-v2 or full-graph capability is exposed here.

mod backend;
mod backend_admission_support;
mod backend_finalization;
mod backend_run_intent;
mod backend_runtime;
mod backend_support;
mod config;
mod credential_runtime;
mod credentials;
#[cfg(test)]
mod credentials_tests;
mod journal;
#[cfg(test)]
mod journal_tests;
pub mod ports;
mod run_intent;
mod run_intent_executor;
#[cfg(all(test, unix))]
mod run_intent_executor_tests;
mod run_intent_http;
#[cfg(all(test, unix))]
mod run_intent_test_support;
#[cfg(all(test, unix))]
mod run_intent_tests;
mod server;
mod server_auth;
mod server_process;
#[cfg(all(test, unix))]
mod server_tests;
mod server_transport;
#[cfg(all(test, unix))]
mod server_transport_tests;
mod server_workspace;
#[cfg(all(test, unix))]
mod test_support;
mod worker;

pub use backend::HostedBackend;
pub use config::{HostedAuthority, HostedAuthorityConfig};
pub use server::{production_backend, serve, OECP_CAPABILITY_FILE_ENV, OECP_PORT};
pub use server_process::run_server_process;
