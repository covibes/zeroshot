pub mod driver;
pub mod process;

use serde::{Deserialize, Serialize};

/// Workspace permission granted to a provider subprocess.
#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceAccessMode {
    ReadOnly,
    #[default]
    Exclusive,
}

/// Lifetime of one reusable provider session.
#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum SessionScope {
    #[default]
    Execution,
    NodeInstance,
}
