//! Public native-v2 run admission and inventory values.
//!
//! The protocol carries the graph, its actual initial value, shipping authorization, and the
//! existing submission-key seam. Harness/provider configuration and credentials are target-owned
//! runtime state and are deliberately absent.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{GraphSpec, IdempotencyKey, RunId, RunStatusResult};

pub const RUN_SUBMIT_METHOD: &str = "run/submit";
pub const RUN_LIST_METHOD: &str = "run/list";
pub const RUN_STATUS_METHOD: &str = "run/status";
pub const RUN_WATCH_METHOD: &str = "run/watch";
pub const RUN_LOGS_METHOD: &str = "run/logs";
pub const RUN_ATTACH_METHOD: &str = "run/attach";
pub const RUN_FORCE_METHOD: &str = "run/force";

/// Secret-free native-v2 submission admitted by the selected target.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunSubmitParams {
    pub graph: GraphSpec,
    pub initial_input: Value,
    #[serde(default)]
    pub ship: bool,
    pub submission_key: IdempotencyKey,
}

/// A successful submission returns the one public identity used by every later run method.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunSubmitResult {
    pub run_id: RunId,
}

/// The MVP inventory has no filters or pagination controls.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RunListParams {}

/// Current durable projections for every retained run.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunListResult {
    pub runs: Vec<RunStatusResult>,
}
