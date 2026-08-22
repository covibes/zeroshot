//! CLI-visible hosted run lifecycle.
//!
//! The wire representation is shared with hosts; these aliases retain the CLI-facing API names.

pub use openengine_cluster_protocol::{
    HostedRunForceResult as CliRunForceResult, HostedRunListResult as CliRunListResult,
    HostedRunStatus as CliRunStatus, HostedRunStatusResult as CliRunStatusResult,
    HostedRunWatchEventNotification as CliRunWatchEventNotification,
};
