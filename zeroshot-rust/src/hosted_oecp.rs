//! Minimal hosted OECP adapter for the existing legacy Node worker.
//!
//! This process is a capsule workload. It deliberately owns neither capsule
//! allocation nor capsule termination; its lifetime is the lifetime assigned by
//! the capsule supervisor.

mod backend;
mod credentials;
mod journal;
mod run_intent;
mod server;
mod worker;

pub use backend::HostedBackend;
pub use server::{serve, OECP_PORT};
