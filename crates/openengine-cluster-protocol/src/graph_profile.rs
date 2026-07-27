//! Supported graph profile advertisement: the enum, its canonical order, and the
//! deterministic, duplicate-free set used by `ServerCapabilities`.

use std::fmt;

use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::{de, Deserialize, Deserializer, Serialize};
use thiserror::Error;

pub const FULL_GRAPH_PROFILE: &str = "openengine.graph.full/v1";
pub const SINGLE_WORKER_GRAPH_PROFILE: &str = "openengine.graph.single-worker/v1";

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
pub enum GraphProfile {
    #[serde(rename = "openengine.graph.full/v1")]
    #[schemars(rename = "openengine.graph.full/v1")]
    Full,
    #[serde(rename = "openengine.graph.single-worker/v1")]
    #[schemars(rename = "openengine.graph.single-worker/v1")]
    SingleWorker,
}

impl GraphProfile {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Full => FULL_GRAPH_PROFILE,
            Self::SingleWorker => SINGLE_WORKER_GRAPH_PROFILE,
        }
    }
}

impl fmt::Display for GraphProfile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Canonical ordering for advertised graph profiles: declaration order is ascending order.
pub const GRAPH_PROFILES: [GraphProfile; 2] = [GraphProfile::Full, GraphProfile::SingleWorker];

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum GraphProfilesError {
    #[error("graph profiles must not contain duplicates")]
    Duplicate,
    #[error("graph profiles must be in canonical ascending order")]
    Unordered,
}

fn reject_out_of_order(values: &[GraphProfile]) -> Result<(), GraphProfilesError> {
    for pair in values.windows(2) {
        match pair[0].cmp(&pair[1]) {
            std::cmp::Ordering::Equal => return Err(GraphProfilesError::Duplicate),
            std::cmp::Ordering::Greater => return Err(GraphProfilesError::Unordered),
            std::cmp::Ordering::Less => {}
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct GraphProfileSet(Vec<GraphProfile>);

impl GraphProfileSet {
    pub fn new(values: Vec<GraphProfile>) -> Result<Self, GraphProfilesError> {
        reject_out_of_order(&values)?;
        Ok(Self(values))
    }

    #[must_use]
    pub fn values(&self) -> &[GraphProfile] {
        &self.0
    }

    #[must_use]
    pub fn contains(&self, profile: GraphProfile) -> bool {
        self.0.contains(&profile)
    }
}

impl<'de> Deserialize<'de> for GraphProfileSet {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let values = Vec::<GraphProfile>::deserialize(deserializer)?;
        reject_out_of_order(&values).map_err(de::Error::custom)?;
        Ok(Self(values))
    }
}

/// `schema_with` target for the `graphProfiles` field: `GraphProfileSet` has no standalone
/// `JsonSchema` impl because its wire shape only ever appears inline on that field.
pub fn graph_profile_set_schema(generator: &mut SchemaGenerator) -> Schema {
    let full = GraphProfile::Full.as_str();
    let single_worker = GraphProfile::SingleWorker.as_str();
    json_schema!({
        "type": "array",
        "maxItems": GRAPH_PROFILES.len(),
        "uniqueItems": true,
        "items": generator.subschema_for::<GraphProfile>(),
        "not": {
            "minItems": 2,
            "prefixItems": [
                { "const": single_worker },
                { "const": full }
            ]
        }
    })
}
