//! Unpublished, single-run OECP capsule runtime for the bounded legacy Node worker.
//!
//! The runtime owns process containment and protocol state. Trusted capsule-agent services own
//! workspace preparation, proxy credential cleanup, and Git delivery through the closed ports in
//! [`ports`]. No native-v2 or full-graph capability is exposed here.

mod backend;
mod backend_admission_support;
mod backend_finalization;
mod backend_runtime;
mod backend_support;
mod config;
mod journal;
#[cfg(test)]
mod journal_tests;
pub mod ports;
mod server;
mod server_auth;
mod server_process;
#[cfg(all(test, unix))]
mod server_tests;
mod server_workspace;
#[cfg(all(test, unix))]
mod test_support;
mod worker;

pub use backend::HostedBackend;
pub use config::{HostedAuthority, HostedAuthorityConfig};
pub use server::{production_backend, serve, OECP_CAPABILITY_FILE_ENV, OECP_PORT};
pub use server_process::run_server_process;
