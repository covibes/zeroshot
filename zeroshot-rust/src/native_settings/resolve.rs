//! CLI-override, environment, profile, and product-default precedence resolution.
//!
//! Precedence, highest wins: explicit CLI option > `ZEROSHOT_RUST_*` environment > the selected
//! native named profile > the Rust catalog/product default. Only `ZEROSHOT_RUST_*` environment
//! variables are read here; this module never inspects Node settings, npm configuration, or any
//! legacy alias.

use std::collections::BTreeMap;

use super::profile::ProfileRegistry;
use super::*;

/// Already-parsed CLI input. Parsing argv into this shape is CLI-command scope, owned elsewhere;
/// this type only carries the parsed result through precedence resolution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CliOverride {
    pub profile: Option<ProfileId>,
    pub settings: NativeSettingsSchema,
}

impl CliOverride {
    #[must_use]
    pub fn new(profile: Option<ProfileId>, settings: NativeSettingsSchema) -> Self {
        Self { profile, settings }
    }
}

/// Reads only `ZEROSHOT_RUST_PROFILE` and the seven `ZEROSHOT_RUST_<DOMAIN>` reference
/// variables. Each reference variable, when present, must be `id@version`; a malformed or empty
/// value is a bounded error naming the variable.
pub fn parse_env_settings(
    env: &BTreeMap<String, String>,
) -> Result<(Option<ProfileId>, NativeSettingsSchema), NativeSettingsError> {
    let profile = parse_profile_env(env)?;
    let settings = parse_reference_env(env)?;
    Ok((profile, settings))
}

fn parse_profile_env(
    env: &BTreeMap<String, String>,
) -> Result<Option<ProfileId>, NativeSettingsError> {
    match env.get("ZEROSHOT_RUST_PROFILE") {
        None => Ok(None),
        Some(value) if value.is_empty() => Err(NativeSettingsError::new(
            "ZEROSHOT_RUST_PROFILE",
            "must not be empty",
        )),
        Some(value) => Ok(Some(ProfileId::new(value.as_str())?)),
    }
}

fn parse_reference_env(
    env: &BTreeMap<String, String>,
) -> Result<NativeSettingsSchema, NativeSettingsError> {
    NativeSettingsSchema::new(NativeSettingsSchemaSpec {
        provider: parse_ref_env(
            env,
            "ZEROSHOT_RUST_PROVIDER",
            |id| ProviderSettingsId::new(id),
            ProviderSettingsRef::new,
        )?,
        source: parse_ref_env(
            env,
            "ZEROSHOT_RUST_SOURCE",
            |id| SourceSettingsId::new(id),
            SourceSettingsRef::new,
        )?,
        issue: parse_ref_env(
            env,
            "ZEROSHOT_RUST_ISSUE",
            |id| IssueSettingsId::new(id),
            IssueSettingsRef::new,
        )?,
        workspace: parse_ref_env(
            env,
            "ZEROSHOT_RUST_WORKSPACE",
            |id| WorkspaceSettingsId::new(id),
            WorkspaceSettingsRef::new,
        )?,
        gateway: parse_ref_env(
            env,
            "ZEROSHOT_RUST_GATEWAY",
            |id| GatewaySettingsId::new(id),
            GatewaySettingsRef::new,
        )?,
        daemon: parse_ref_env(
            env,
            "ZEROSHOT_RUST_DAEMON",
            |id| DaemonSettingsId::new(id),
            DaemonSettingsRef::new,
        )?,
        policy: parse_ref_env(
            env,
            "ZEROSHOT_RUST_POLICY",
            |id| PolicySettingsId::new(id),
            PolicySettingsRef::new,
        )?,
        credential_requirements: std::collections::BTreeSet::new(),
    })
}

fn parse_ref_env<Id, Ref>(
    env: &BTreeMap<String, String>,
    key: &'static str,
    new_id: impl FnOnce(&str) -> Result<Id, NativeSettingsError>,
    new_ref: impl FnOnce(Id, u32) -> Result<Ref, NativeSettingsError>,
) -> Result<Option<Ref>, NativeSettingsError> {
    let Some(value) = env.get(key) else {
        return Ok(None);
    };
    if value.is_empty() {
        return Err(NativeSettingsError::new(key, "must not be empty"));
    }
    let (id_part, version_part) = value
        .split_once('@')
        .ok_or_else(|| NativeSettingsError::new(key, "expected `id@version`"))?;
    let version: u32 = version_part
        .parse()
        .map_err(|_error| NativeSettingsError::new(key, "version must be a positive integer"))?;
    let id = new_id(id_part)?;
    new_ref(id, version).map(Some)
}

/// Resolves final settings in precedence order: CLI > environment > selected profile > product
/// default. A CLI or environment profile selection naming a profile absent from `profiles` is a
/// bounded `unknown profile` error.
pub fn resolve(
    cli: &CliOverride,
    env: &BTreeMap<String, String>,
    profiles: &ProfileRegistry,
    product_default: &NativeSettingsSchema,
) -> Result<NativeSettingsSchema, NativeSettingsError> {
    let (env_profile, env_settings) = parse_env_settings(env)?;
    let profile_id = cli.profile.clone().or(env_profile);
    let profile_settings = match profile_id {
        Some(id) => profiles.canonicalize().remove(&id).ok_or_else(|| {
            NativeSettingsError::new("native settings profile", "unknown profile")
        })?,
        None => NativeSettingsSchema::default(),
    };
    Ok(product_default
        .layer_over(&profile_settings)
        .layer_over(&env_settings)
        .layer_over(&cli.settings))
}
