pub mod driver;
pub mod process;

use serde::{Deserialize, Serialize};

pub use openengine_cluster_protocol::SessionScope;

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
