use openengine_cluster_protocol::{RUN_PROFILES_KIND, TargetDiscoveryExtensions};
use reqwest::Url;

use super::{authority_error, capability_base_url, compile_literal_route};
use crate::native_v2_target::TargetAuthorityError;

#[derive(Clone)]
pub(in super::super) struct RunProfilesDescriptor {
    pub(in super::super) list: Url,
    pub(in super::super) show: Url,
    pub(in super::super) set: Url,
    pub(in super::super) delete: Url,
    pub(in super::super) default: Url,
    pub(in super::super) run: Url,
}

pub(super) fn build_profiles_descriptor(
    origin: &Url,
    extensions: &TargetDiscoveryExtensions,
) -> Result<Option<RunProfilesDescriptor>, TargetAuthorityError> {
    let Some(wire) = extensions.run_profiles.as_ref() else {
        return Ok(None);
    };
    if wire.kind != RUN_PROFILES_KIND {
        return Err(authority_error("run-profile discovery is incompatible"));
    }
    let base_url = capability_base_url(origin, &wire.base_url)?;
    Ok(Some(RunProfilesDescriptor {
        list: compile_literal_route(&base_url, &wire.route_templates.list, "run-profile")?,
        show: compile_literal_route(&base_url, &wire.route_templates.show, "run-profile")?,
        set: compile_literal_route(&base_url, &wire.route_templates.set, "run-profile")?,
        delete: compile_literal_route(&base_url, &wire.route_templates.delete, "run-profile")?,
        default: compile_literal_route(&base_url, &wire.route_templates.default, "run-profile")?,
        run: compile_literal_route(&base_url, &wire.route_templates.run, "run-profile")?,
    }))
}
