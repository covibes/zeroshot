use openengine_cluster_protocol::{
    ApplyParams, DeleteParams, ResubmitParams, RetryParams, StopParams, UpdateParams,
};
use schemars::schema_for;
use serde_json::{json, Value};

pub(super) fn document() -> Value {
    json!({
        "openrpc": "1.3.2",
        "info": {
            "title": "Open Engine Cluster Protocol",
            "version": "1.0.0"
        },
        "methods": [
            initialize_method(),
            plan_method(),
            apply_method(),
            update_method(),
            stop_method(),
            retry_method(),
            resubmit_method(),
            delete_method(),
            get_method(),
            watch_method(),
        ],
        "components": {
            "schemas": {
                "GraphSpec": { "$ref": "graph.schema.json" },
                "CompiledGraphIr": { "$ref": "compiled-ir.schema.json" },
                "GraphDiagnostic": { "$ref": "graph.schema.json#/$defs/GraphDiagnostic" },
                "StructuralBounds": { "$ref": "graph.schema.json#/$defs/StructuralBounds" },
                "ArtifactRef": { "$ref": "graph.schema.json#/$defs/ArtifactRef" }
            }
        },
        "x-generic-subscription-framing": {
            "description": "watch establishes a subscription via one normal JSON-RPC result; \
                subsequent delivery uses the generic notification methods below, shared by any \
                future subscription-based method (e.g. logs/attach). There is no watch/event, \
                watch/cancel, or watch/closed method on the wire.",
            "notifications": {
                "event": { "$ref": "schema.json#/$defs/EventNotification" },
                "subscription/cancel": { "$ref": "schema.json#/$defs/SubscriptionCancelParams" },
                "subscription/closed": { "$ref": "schema.json#/$defs/SubscriptionClosedNotification" }
            }
        }
    })
}

fn initialize_method() -> Value {
    json!({
        "name": "initialize",
        "paramStructure": "by-name",
        "params": [{
            "name": "protocolVersion",
            "required": true,
            "schema": {
                "type": "string",
                "const": "openengine.cluster/v1"
            }
        }],
        "result": {
            "name": "initializeResult",
            "schema": { "$ref": "schema.json#/$defs/InitializeResult" }
        }
    })
}

fn plan_method() -> Value {
    json!({
        "name": "plan",
        "paramStructure": "by-name",
        "params": [{
            "name": "graph",
            "required": true,
            "schema": { "$ref": "schema.json#/$defs/GraphSpec" }
        }],
        "result": {
            "name": "planResult",
            "schema": { "$ref": "schema.json#/$defs/PlanResult" }
        }
    })
}

fn apply_method() -> Value {
    let apply_schema = serde_json::to_value(schema_for!(ApplyParams))
        .expect("apply parameter JSON Schema serialization must succeed");
    json!({
        "name": "apply",
        "paramStructure": "by-name",
        "params": [
            {
                "name": "graph", "required": true,
                "schema": { "$ref": "schema.json#/$defs/GraphSpec" }
            },
            { "name": "input", "required": false, "schema": true },
            {
                "name": "dryRun", "required": false,
                "schema": apply_property_schema(&apply_schema, "dryRun")
            },
            {
                "name": "ifGeneration", "required": false,
                "schema": apply_property_schema(&apply_schema, "ifGeneration")
            },
            {
                "name": "idempotencyKey", "required": false,
                "schema": apply_property_schema(&apply_schema, "idempotencyKey")
            }
        ],
        "result": {
            "name": "applyResult",
            "schema": { "$ref": "schema.json#/$defs/ApplyResult" }
        }
    })
}

fn apply_property_schema(apply_schema: &Value, property: &str) -> Value {
    apply_schema["properties"]
        .get(property)
        .unwrap_or_else(|| panic!("ApplyParams schema is missing {property}"))
        .clone()
}

fn update_method() -> Value {
    let schema = serde_json::to_value(schema_for!(UpdateParams))
        .expect("update parameter JSON Schema serialization must succeed");
    json!({
        "name": "update",
        "paramStructure": "by-name",
        "x-params-schema": schema,
        "params": [
            { "name": "labels", "required": false, "schema": { "$ref": "schema.json#/$defs/Labels" } },
            { "name": "logLevel", "required": false, "schema": { "$ref": "schema.json#/$defs/LogLevel" } },
            { "name": "suspended", "required": false, "schema": { "type": "boolean" } },
            { "name": "ifGeneration", "required": true, "schema": property_schema(&schema, "ifGeneration") },
            { "name": "idempotencyKey", "required": true, "schema": property_schema(&schema, "idempotencyKey") }
        ],
        "result": {
            "name": "updateResult",
            "schema": { "$ref": "schema.json#/$defs/UpdateResult" }
        }
    })
}

fn stop_method() -> Value {
    let schema = serde_json::to_value(schema_for!(StopParams))
        .expect("stop parameter JSON Schema serialization must succeed");
    json!({
        "name": "stop",
        "paramStructure": "by-name",
        "params": [
            { "name": "mode", "required": true, "schema": { "$ref": "schema.json#/$defs/StopMode" } },
            { "name": "ifGeneration", "required": true, "schema": property_schema(&schema, "ifGeneration") },
            { "name": "idempotencyKey", "required": true, "schema": property_schema(&schema, "idempotencyKey") }
        ],
        "result": {
            "name": "stopResult",
            "schema": { "$ref": "schema.json#/$defs/StopResult" }
        }
    })
}

fn retry_method() -> Value {
    let schema = serde_json::to_value(schema_for!(RetryParams))
        .expect("retry parameter JSON Schema serialization must succeed");
    json!({
        "name": "retry",
        "paramStructure": "by-name",
        "params": [
            { "name": "ifGeneration", "required": true, "schema": property_schema(&schema, "ifGeneration") },
            { "name": "idempotencyKey", "required": true, "schema": property_schema(&schema, "idempotencyKey") }
        ],
        "result": {
            "name": "retryResult",
            "schema": { "$ref": "schema.json#/$defs/RetryResult" }
        }
    })
}

fn resubmit_method() -> Value {
    let schema = serde_json::to_value(schema_for!(ResubmitParams))
        .expect("resubmit parameter JSON Schema serialization must succeed");
    json!({
        "name": "resubmit",
        "paramStructure": "by-name",
        "params": [
            { "name": "ifGeneration", "required": true, "schema": property_schema(&schema, "ifGeneration") },
            { "name": "ifRunId", "required": true, "schema": property_schema(&schema, "ifRunId") },
            { "name": "idempotencyKey", "required": true, "schema": property_schema(&schema, "idempotencyKey") },
            { "name": "replacementInput", "required": false, "schema": true }
        ],
        "result": {
            "name": "resubmitResult",
            "schema": { "$ref": "schema.json#/$defs/ResubmitResult" }
        }
    })
}

fn delete_method() -> Value {
    let schema = serde_json::to_value(schema_for!(DeleteParams))
        .expect("delete parameter JSON Schema serialization must succeed");
    json!({
        "name": "delete",
        "paramStructure": "by-name",
        "params": [
            { "name": "ifGeneration", "required": true, "schema": property_schema(&schema, "ifGeneration") },
            { "name": "ifRunId", "required": false, "schema": property_schema(&schema, "ifRunId") },
            { "name": "idempotencyKey", "required": true, "schema": property_schema(&schema, "idempotencyKey") }
        ],
        "result": {
            "name": "deleteResult",
            "schema": { "$ref": "schema.json#/$defs/DeleteResult" }
        }
    })
}

fn property_schema(schema: &Value, property: &str) -> Value {
    schema["properties"]
        .get(property)
        .unwrap_or_else(|| panic!("parameter schema is missing {property}"))
        .clone()
}

fn get_method() -> Value {
    json!({
        "name": "get",
        "paramStructure": "by-name",
        "params": [{
            "name": "atCursor",
            "required": false,
            "schema": { "type": ["string", "null"] }
        }],
        "result": {
            "name": "getResult",
            "schema": { "$ref": "schema.json#/$defs/GetResult" }
        }
    })
}

fn watch_method() -> Value {
    json!({
        "name": "watch",
        "paramStructure": "by-name",
        "params": [
            {
                "name": "runId", "required": false,
                "schema": { "type": ["string", "null"] }
            },
            {
                "name": "fromCursor", "required": false,
                "schema": { "type": ["string", "null"] }
            }
        ],
        "result": {
            "name": "watchResult",
            "schema": { "$ref": "schema.json#/$defs/WatchResult" }
        }
    })
}
