//! Isolated native configuration and named profile definitions.
//!
//! This module parses `ZEROSHOT_RUST_*` environment overrides, CLI-supplied overrides, and named
//! profile files into a bounded, secret-free [`NativeSettingsSchema`]. It owns configuration
//! precedence and OS-native path resolution only. The provider catalog, role prompts, admission
//! manifests, and credential acquisition are owned elsewhere.

pub mod paths;
pub mod profile;
pub mod resolve;

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::provider_value::BoundedSet;

crate::provider_value::contract_error_type!(NativeSettingsError);

pub const NATIVE_SETTINGS_SCHEMA_VERSION: u32 = 1;

crate::provider_value::provider_id_type!(
    ProviderSettingsId,
    NativeSettingsError,
    "provider settings id"
);
crate::provider_value::provider_ref_type!(
    ProviderSettingsRef,
    ProviderSettingsId,
    NativeSettingsError,
    "provider settings version"
);
crate::provider_value::provider_id_type!(
    SourceSettingsId,
    NativeSettingsError,
    "source settings id"
);
crate::provider_value::provider_ref_type!(
    SourceSettingsRef,
    SourceSettingsId,
    NativeSettingsError,
    "source settings version"
);
crate::provider_value::provider_id_type!(IssueSettingsId, NativeSettingsError, "issue settings id");
crate::provider_value::provider_ref_type!(
    IssueSettingsRef,
    IssueSettingsId,
    NativeSettingsError,
    "issue settings version"
);
crate::provider_value::provider_id_type!(
    WorkspaceSettingsId,
    NativeSettingsError,
    "workspace settings id"
);
crate::provider_value::provider_ref_type!(
    WorkspaceSettingsRef,
    WorkspaceSettingsId,
    NativeSettingsError,
    "workspace settings version"
);
crate::provider_value::provider_id_type!(
    GatewaySettingsId,
    NativeSettingsError,
    "gateway settings id"
);
crate::provider_value::provider_ref_type!(
    GatewaySettingsRef,
    GatewaySettingsId,
    NativeSettingsError,
    "gateway settings version"
);
crate::provider_value::provider_id_type!(
    DaemonSettingsId,
    NativeSettingsError,
    "daemon settings id"
);
crate::provider_value::provider_ref_type!(
    DaemonSettingsRef,
    DaemonSettingsId,
    NativeSettingsError,
    "daemon settings version"
);
crate::provider_value::provider_id_type!(
    PolicySettingsId,
    NativeSettingsError,
    "policy settings id"
);
crate::provider_value::provider_ref_type!(
    PolicySettingsRef,
    PolicySettingsId,
    NativeSettingsError,
    "policy settings version"
);

crate::provider_value::provider_id_type!(
    CredentialRequirementName,
    NativeSettingsError,
    "credential requirement name"
);
crate::provider_value::bounded_text_type!(ProfileId, 128, NativeSettingsError, "profile id");

/// Builder input for [`NativeSettingsSchema::new`]. A struct (rather than positional
/// arguments) keeps the eight logical-reference fields readable at call sites.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct NativeSettingsSchemaSpec {
    pub provider: Option<ProviderSettingsRef>,
    pub source: Option<SourceSettingsRef>,
    pub issue: Option<IssueSettingsRef>,
    pub workspace: Option<WorkspaceSettingsRef>,
    pub gateway: Option<GatewaySettingsRef>,
    pub daemon: Option<DaemonSettingsRef>,
    pub policy: Option<PolicySettingsRef>,
    pub credential_requirements: BTreeSet<CredentialRequirementName>,
}

/// Bounded, secret-free settings referencing provider/source/issue/workspace/gateway/daemon/
/// policy configuration by logical id@version only. No credential material, endpoint, or command
/// ever enters this type.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "NativeSettingsSchemaWire", rename_all = "camelCase")]
pub struct NativeSettingsSchema {
    provider: Option<ProviderSettingsRef>,
    source: Option<SourceSettingsRef>,
    issue: Option<IssueSettingsRef>,
    workspace: Option<WorkspaceSettingsRef>,
    gateway: Option<GatewaySettingsRef>,
    daemon: Option<DaemonSettingsRef>,
    policy: Option<PolicySettingsRef>,
    credential_requirements: BoundedSet<CredentialRequirementName>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeSettingsSchemaWire {
    #[serde(default)]
    provider: Option<ProviderSettingsRef>,
    #[serde(default)]
    source: Option<SourceSettingsRef>,
    #[serde(default)]
    issue: Option<IssueSettingsRef>,
    #[serde(default)]
    workspace: Option<WorkspaceSettingsRef>,
    #[serde(default)]
    gateway: Option<GatewaySettingsRef>,
    #[serde(default)]
    daemon: Option<DaemonSettingsRef>,
    #[serde(default)]
    policy: Option<PolicySettingsRef>,
    #[serde(default)]
    credential_requirements: Vec<CredentialRequirementName>,
}

impl TryFrom<NativeSettingsSchemaWire> for NativeSettingsSchema {
    type Error = NativeSettingsError;

    fn try_from(wire: NativeSettingsSchemaWire) -> Result<Self, Self::Error> {
        NativeSettingsError::checked(Self {
            provider: wire.provider,
            source: wire.source,
            issue: wire.issue,
            workspace: wire.workspace,
            gateway: wire.gateway,
            daemon: wire.daemon,
            policy: wire.policy,
            credential_requirements: BoundedSet::new(
                wire.credential_requirements.into_iter().collect(),
            )
            .map_err(|error| NativeSettingsError::new("credential requirements", error))?,
        })
    }
}

impl Default for NativeSettingsSchema {
    fn default() -> Self {
        Self {
            provider: None,
            source: None,
            issue: None,
            workspace: None,
            gateway: None,
            daemon: None,
            policy: None,
            credential_requirements: BoundedSet::new(BTreeSet::new())
                .expect("an empty credential requirement set is always within bounds"),
        }
    }
}

impl NativeSettingsSchema {
    pub fn new(spec: NativeSettingsSchemaSpec) -> Result<Self, NativeSettingsError> {
        NativeSettingsError::checked(Self {
            provider: spec.provider,
            source: spec.source,
            issue: spec.issue,
            workspace: spec.workspace,
            gateway: spec.gateway,
            daemon: spec.daemon,
            policy: spec.policy,
            credential_requirements: BoundedSet::new(spec.credential_requirements)
                .map_err(|error| NativeSettingsError::new("credential requirements", error))?,
        })
    }

    #[must_use]
    pub fn provider(&self) -> Option<&ProviderSettingsRef> {
        self.provider.as_ref()
    }

    #[must_use]
    pub fn source(&self) -> Option<&SourceSettingsRef> {
        self.source.as_ref()
    }

    #[must_use]
    pub fn issue(&self) -> Option<&IssueSettingsRef> {
        self.issue.as_ref()
    }

    #[must_use]
    pub fn workspace(&self) -> Option<&WorkspaceSettingsRef> {
        self.workspace.as_ref()
    }

    #[must_use]
    pub fn gateway(&self) -> Option<&GatewaySettingsRef> {
        self.gateway.as_ref()
    }

    #[must_use]
    pub fn daemon(&self) -> Option<&DaemonSettingsRef> {
        self.daemon.as_ref()
    }

    #[must_use]
    pub fn policy(&self) -> Option<&PolicySettingsRef> {
        self.policy.as_ref()
    }

    #[must_use]
    pub fn credential_requirements(&self) -> &BTreeSet<CredentialRequirementName> {
        self.credential_requirements.as_set()
    }

    /// Layers `higher` over `self`: a present field on `higher` wins, otherwise `self`'s value
    /// carries through. `credential_requirements` is replaced wholesale when `higher` is
    /// non-empty, never unioned field-by-field.
    #[must_use]
    pub fn layer_over(&self, higher: &Self) -> Self {
        Self {
            provider: higher.provider.clone().or_else(|| self.provider.clone()),
            source: higher.source.clone().or_else(|| self.source.clone()),
            issue: higher.issue.clone().or_else(|| self.issue.clone()),
            workspace: higher.workspace.clone().or_else(|| self.workspace.clone()),
            gateway: higher.gateway.clone().or_else(|| self.gateway.clone()),
            daemon: higher.daemon.clone().or_else(|| self.daemon.clone()),
            policy: higher.policy.clone().or_else(|| self.policy.clone()),
            credential_requirements: if higher.credential_requirements.as_set().is_empty() {
                self.credential_requirements.clone()
            } else {
                higher.credential_requirements.clone()
            },
        }
    }
}
