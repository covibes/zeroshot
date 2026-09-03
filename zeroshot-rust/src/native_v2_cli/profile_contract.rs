use openengine_cluster_protocol::{RunProfileName, RunProfileScope};

use super::{RunGraph, RunRuntime};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunSelection {
    Inline {
        graph: RunGraph,
        runtime: RunRuntime,
    },
    /// `None` means resolve the first available scoped default.
    Profile(Option<ProfileReference>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileQualifier {
    Local,
    User,
    Org,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileReference {
    pub qualifier: Option<ProfileQualifier>,
    pub name: RunProfileName,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileRoute {
    pub target: Option<String>,
    pub scope: RunProfileScope,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileSetCommand {
    pub route: ProfileRoute,
    pub name: RunProfileName,
    pub graph: RunGraph,
    pub runtime: RunRuntime,
    pub set_default: bool,
}
