use openengine_cluster_protocol::{Cursor, ExecutionRef, RunId};
use reqwest::Url;
use openengine_cluster_protocol::TargetDiscoveryExtensions;

use super::{authority_error, same_origin_url, valid_literal_route_segment};
use crate::native_v2_target::TargetAuthorityError;

const HOSTED_RUNS_KIND: &str = "zeroshot.hosted-runs/v1";

#[derive(Clone)]
pub(in super::super) struct HostedRunsDescriptor {
    base_url: Url,
    list: HostedRunRoute,
    status: HostedRunRoute,
    watch: HostedRunRoute,
    logs: HostedRunRoute,
    force: HostedRunRoute,
}

#[derive(Clone)]
struct HostedRunRoute {
    segments: Vec<HostedRunRouteSegment>,
    query: Vec<HostedRunQuery>,
}

#[derive(Clone)]
enum HostedRunRouteSegment {
    Literal(String),
    RunId,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum HostedRunQuery {
    FromCursor,
    Execution,
}

#[derive(Clone, Copy, Default)]
struct RouteValues<'a> {
    run_id: Option<&'a RunId>,
    from_cursor: Option<&'a Cursor>,
    execution: Option<&'a ExecutionRef>,
}

impl HostedRunsDescriptor {
    pub(in super::super) fn list_url(&self) -> Result<Url, TargetAuthorityError> {
        self.list.expand(&self.base_url, RouteValues::default())
    }

    pub(in super::super) fn status_url(&self, run_id: &RunId) -> Result<Url, TargetAuthorityError> {
        self.status.expand(
            &self.base_url,
            RouteValues {
                run_id: Some(run_id),
                ..RouteValues::default()
            },
        )
    }

    pub(in super::super) fn watch_url(
        &self,
        run_id: &RunId,
        from_cursor: Option<&Cursor>,
    ) -> Result<Url, TargetAuthorityError> {
        self.watch.expand(
            &self.base_url,
            RouteValues {
                run_id: Some(run_id),
                from_cursor,
                execution: None,
            },
        )
    }

    pub(in super::super) fn logs_url(
        &self,
        run_id: &RunId,
        from_cursor: Option<&Cursor>,
        execution: Option<&ExecutionRef>,
    ) -> Result<Url, TargetAuthorityError> {
        self.logs.expand(
            &self.base_url,
            RouteValues {
                run_id: Some(run_id),
                from_cursor,
                execution,
            },
        )
    }

    pub(in super::super) fn force_url(&self, run_id: &RunId) -> Result<Url, TargetAuthorityError> {
        self.force.expand(
            &self.base_url,
            RouteValues {
                run_id: Some(run_id),
                ..RouteValues::default()
            },
        )
    }
}

impl HostedRunRoute {
    fn expand(&self, base_url: &Url, values: RouteValues<'_>) -> Result<Url, TargetAuthorityError> {
        let mut url = base_url.clone();
        self.append_path(&mut url, values.run_id)?;
        self.append_query(&mut url, values);
        Ok(url)
    }

    fn append_path(
        &self,
        url: &mut Url,
        run_id: Option<&RunId>,
    ) -> Result<(), TargetAuthorityError> {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| authority_error("hosted run base URL is invalid"))?;
        path.pop_if_empty();
        for segment in &self.segments {
            let value = match segment {
                HostedRunRouteSegment::Literal(segment) => segment.as_str(),
                HostedRunRouteSegment::RunId => run_id
                    .ok_or_else(|| authority_error("hosted run route is incomplete"))?
                    .as_str(),
            };
            path.push(value);
        }
        Ok(())
    }

    fn append_query(&self, url: &mut Url, values: RouteValues<'_>) {
        if values.from_cursor.is_none() && values.execution.is_none() {
            return;
        }
        let mut query = url.query_pairs_mut();
        for variable in &self.query {
            match variable {
                HostedRunQuery::FromCursor => values.from_cursor.map(|cursor| {
                    query.append_pair("from_cursor", cursor.as_str());
                }),
                HostedRunQuery::Execution => values.execution.map(|execution| {
                    query.append_pair("execution", execution.as_str());
                }),
            };
        }
    }
}

pub(super) fn build_hosted_runs_descriptor(
    origin: &Url,
    extensions: &TargetDiscoveryExtensions,
) -> Result<HostedRunsDescriptor, TargetAuthorityError> {
    let wire = extensions.hosted_runs.as_ref().ok_or_else(|| {
        authority_error("hosted target does not advertise zeroshot.hosted-runs/v1")
    })?;
    if wire.kind != HOSTED_RUNS_KIND {
        return Err(authority_error("hosted run discovery is incompatible"));
    }
    let base_url = if origin
        .as_str()
        .strip_suffix('/')
        .is_some_and(|root| root == wire.base_url)
    {
        origin.clone()
    } else {
        same_origin_url(origin, &wire.base_url)?
    };
    Ok(HostedRunsDescriptor {
        base_url,
        list: compile_hosted_run_route(&wire.route_templates.list, false, &[])?,
        status: compile_hosted_run_route(&wire.route_templates.status, true, &[])?,
        watch: compile_hosted_run_route(
            &wire.route_templates.watch,
            true,
            &[HostedRunQuery::FromCursor],
        )?,
        logs: compile_hosted_run_route(
            &wire.route_templates.logs,
            true,
            &[HostedRunQuery::FromCursor, HostedRunQuery::Execution],
        )?,
        force: compile_hosted_run_route(&wire.route_templates.force, true, &[])?,
    })
}

fn compile_hosted_run_route(
    value: &str,
    requires_run_id: bool,
    expected_query: &[HostedRunQuery],
) -> Result<HostedRunRoute, TargetAuthorityError> {
    validate_route_template(value)?;
    let (path, query) = split_route_query(value)?;
    if query != expected_query {
        return Err(unsupported_variables());
    }
    let (segments, found_run_id) = compile_route_segments(path)?;
    if found_run_id != requires_run_id {
        return Err(unsupported_variables());
    }
    Ok(HostedRunRoute {
        segments,
        query: query.to_vec(),
    })
}

fn validate_route_template(value: &str) -> Result<(), TargetAuthorityError> {
    if value.len() > 2_048
        || !value.starts_with('/')
        || value.starts_with("//")
        || value.contains('\\')
        || value.contains('#')
        || value
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(authority_error("hosted run route template is invalid"));
    }
    Ok(())
}

fn compile_route_segments(
    path: &str,
) -> Result<(Vec<HostedRunRouteSegment>, bool), TargetAuthorityError> {
    let mut found_run_id = false;
    let mut segments = Vec::new();
    for segment in path.split('/').skip(1) {
        if segment == "{run_id}" {
            if found_run_id {
                return Err(unsupported_variables());
            }
            found_run_id = true;
            segments.push(HostedRunRouteSegment::RunId);
        } else if valid_literal_route_segment(segment) {
            segments.push(HostedRunRouteSegment::Literal(segment.to_owned()));
        } else {
            return Err(authority_error("hosted run route template is invalid"));
        }
    }
    Ok((segments, found_run_id))
}

fn unsupported_variables() -> TargetAuthorityError {
    authority_error("hosted run route template declares unsupported variables")
}

fn split_route_query(value: &str) -> Result<(&str, Vec<HostedRunQuery>), TargetAuthorityError> {
    if let Some(path) = value.strip_suffix("{?from_cursor}") {
        return Ok((path, vec![HostedRunQuery::FromCursor]));
    }
    if let Some(path) = value.strip_suffix("{?from_cursor,execution}") {
        return Ok((
            path,
            vec![HostedRunQuery::FromCursor, HostedRunQuery::Execution],
        ));
    }
    if value.contains('?') {
        return Err(authority_error("hosted run route template is invalid"));
    }
    Ok((value, Vec::new()))
}

#[cfg(test)]
mod tests {
    use openengine_cluster_testkit::assertions::AssertValue;
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn hosted_routes_expand_opaque_values_under_the_advertised_base_path() {
        let origin = Url::parse("https://target.example").assert_value();
        let descriptor = descriptor(
            &origin,
            json!({
                "kind": HOSTED_RUNS_KIND,
                "base_url": "https://target.example/api/",
                "route_templates": routes()
            }),
        )
        .assert_value();

        assert_eq!(
            descriptor.list_url().assert_value().as_str(),
            "https://target.example/api/native-v2/runs"
        );
        assert_eq!(
            descriptor
                .watch_url(&RunId::new("run/1"), Some(&Cursor::new("cloud:7")))
                .assert_value()
                .as_str(),
            "https://target.example/api/native-v2/runs/run%2F1/watch?from_cursor=cloud%3A7"
        );
        assert_eq!(
            descriptor
                .logs_url(
                    &RunId::new("run/1"),
                    Some(&Cursor::new("cloud:8")),
                    Some(&ExecutionRef::new("worker/1").assert_value()),
                )
                .assert_value()
                .as_str(),
            "https://target.example/api/native-v2/runs/run%2F1/logs?from_cursor=cloud%3A8&execution=worker%2F1"
        );
    }

    #[test]
    fn hosted_routes_reject_missing_cross_origin_or_unsafe_capabilities() {
        let origin = Url::parse("https://target.example").assert_value();
        let invalid = [
            Value::Null,
            json!({
                "kind": "zeroshot.hosted-runs/v2",
                "base_url": "https://target.example",
                "route_templates": routes()
            }),
            json!({
                "kind": HOSTED_RUNS_KIND,
                "base_url": "https://attacker.example",
                "route_templates": routes()
            }),
            json!({
                "kind": HOSTED_RUNS_KIND,
                "base_url": "https://target.example",
                "route_templates": routes_with("status", "/native-v2/runs")
            }),
            json!({
                "kind": HOSTED_RUNS_KIND,
                "base_url": "https://target.example",
                "route_templates": routes_with("watch", "/../runs/{run_id}/watch{?from_cursor}")
            }),
            json!({
                "kind": HOSTED_RUNS_KIND,
                "base_url": "https://target.example",
                "route_templates": routes_with("logs", "/runs/{run_id}/logs{?execution}")
            }),
        ];

        for hosted_runs in invalid {
            assert!(descriptor(&origin, hosted_runs).is_err());
        }
    }

    fn descriptor(
        origin: &Url,
        hosted_runs: Value,
    ) -> Result<HostedRunsDescriptor, TargetAuthorityError> {
        let extensions = serde_json::from_value::<TargetDiscoveryExtensions>(json!({
            "hosted_runs": hosted_runs
        }))
        .assert_value();
        build_hosted_runs_descriptor(origin, &extensions)
    }

    fn routes() -> Value {
        json!({
            "list": "/native-v2/runs",
            "status": "/native-v2/runs/{run_id}",
            "watch": "/native-v2/runs/{run_id}/watch{?from_cursor}",
            "logs": "/native-v2/runs/{run_id}/logs{?from_cursor,execution}",
            "force": "/native-v2/runs/{run_id}/force"
        })
    }

    fn routes_with(name: &str, value: &str) -> Value {
        let mut routes = routes();
        routes
            .as_object_mut()
            .assert_value()
            .insert(name.to_owned(), Value::String(value.to_owned()));
        routes
    }
}
