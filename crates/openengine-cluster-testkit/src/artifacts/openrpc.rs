use openengine_cluster_protocol::{
    AgentAttachParams, ApplyParams, DeleteParams, ResubmitParams, RetryParams, RunAttachParams,
    RunForceParams, RunLogsParams, RunStatusParams, RunSubmitParams, RunWatchParams, StopParams,
    UpdateParams, RUN_ATTACH_METHOD, RUN_FORCE_METHOD, RUN_LIST_METHOD, RUN_LOGS_METHOD,
    RUN_STATUS_METHOD, RUN_SUBMIT_METHOD, RUN_WATCH_METHOD,
};
use openengine_cluster_server::method_registry::{MethodDescriptor, MethodKind, METHOD_REGISTRY};
use schemars::schema_for;
use serde_json::{json, Value};

pub(super) fn document() -> Value {
    let methods = METHOD_REGISTRY
        .iter()
        .map(method_document)
        .collect::<Vec<_>>();
    json!({
        "openrpc": "1.3.2",
        "info": {
            "title": "Open Engine Cluster Protocol",
            "version": "1.0.0"
        },
        "methods": methods,
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
                "description": "watch, logs, and agent/attach each establish a subscription via one \
                normal JSON-RPC result; native-v2 run/watch, run/logs, and run/attach use the same \
                framing. Subsequent delivery uses the generic notification methods \
                below, shared by every subscription-based method. All six subscription methods \
                are established through the connection layer and are not answerable by \
                Dispatcher::dispatch alone. There is no watch/event, watch/cancel, watch/closed, \
                logs/event, logs/cancel, logs/closed, agent/attach/event, agent/attach/cancel, or \
                agent/attach/closed method on the wire. `$/cancelRequest` is a transport-level \
                best-effort cancellation of any in-flight unary request by its RequestId; it is \
                silently a no-op for an unknown or already-completed id and carries no rollback \
                claim after backend commit.",
            "notifications": {
                "event": { "$ref": "schema.json#/$defs/EventNotification" },
                "subscription/cancel": { "$ref": "schema.json#/$defs/SubscriptionCancelParams" },
                "subscription/closed": { "$ref": "schema.json#/$defs/SubscriptionClosedNotification" },
                "$/cancelRequest": { "$ref": "schema.json#/$defs/CancelRequestParams" }
            }
        }
    })
}
fn method_document(descriptor: &MethodDescriptor) -> Value {
    let mut method = match descriptor.name {
        "initialize" => initialize_method(),
        "plan" => plan_method(),
        "apply" => apply_method(),
        "update" => update_method(),
        "stop" => stop_method(),
        "retry" => retry_method(),
        "resubmit" => resubmit_method(),
        "delete" => delete_method(),
        "get" => get_method(),
        "watch" => watch_method(),
        "logs" => logs_method(),
        "agent/attach" => agent_attach_method(),
        RUN_SUBMIT_METHOD => run_submit_method(),
        RUN_LIST_METHOD => run_list_method(),
        RUN_STATUS_METHOD => run_status_method(),
        RUN_WATCH_METHOD => run_watch_method(),
        RUN_LOGS_METHOD => run_logs_method(),
        RUN_ATTACH_METHOD => run_attach_method(),
        RUN_FORCE_METHOD => run_force_method(),
        name => panic!("METHOD_REGISTRY method has no OpenRPC schema: {name}"),
    };
    let object = method
        .as_object_mut()
        .expect("OpenRPC method builders must return objects");
    object.insert("name".to_owned(), json!(descriptor.name));
    object.insert(
        "x-subscription".to_owned(),
        json!(matches!(descriptor.kind, MethodKind::Subscription(_))),
    );
    object.insert(
        "x-transport-requirements".to_owned(),
        json!({
            "serverPush": descriptor.transport_requirements.server_push,
            "inboundNotifications": descriptor.transport_requirements.inbound_notifications,
        }),
    );
    method
}

fn initialize_method() -> Value {
    json!({
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

fn logs_method() -> Value {
    json!({
        "paramStructure": "by-name",
        "params": [],
        "result": {
            "name": "logsResult",
            "schema": { "$ref": "schema.json#/$defs/LogsResult" }
        }
    })
}

fn agent_attach_method() -> Value {
    // `ExecutionRef` is inline-schema (like `logs`'s `BoundedLogTarget`/`BoundedLogMessage`), so it
    // has no standalone `$defs` entry to `$ref` -- extract its actual inline schema from a
    // generated `AgentAttachParams` schema instead of hand-authoring a `$ref` that would dangle.
    let schema = serde_json::to_value(schema_for!(AgentAttachParams))
        .expect("agent_attach parameter JSON Schema serialization must succeed");
    json!({
        "paramStructure": "by-name",
        "params": [{
            "name": "execution",
            "required": true,
            "schema": property_schema(&schema, "execution")
        }],
        "result": {
            "name": "agentAttachResult",
            "schema": { "$ref": "schema.json#/$defs/AgentAttachResult" }
        }
    })
}

fn run_submit_method() -> Value {
    let schema = serde_json::to_value(schema_for!(RunSubmitParams))
        .expect("run submit parameter JSON Schema serialization must succeed");
    json!({
        "paramStructure": "by-name",
        "params": [
            { "name": "graph", "required": true, "schema": { "$ref": "schema.json#/$defs/GraphSpec" } },
            { "name": "initialInput", "required": true, "schema": true },
            { "name": "ship", "required": false, "schema": property_schema(&schema, "ship") },
            { "name": "submissionKey", "required": true, "schema": property_schema(&schema, "submissionKey") }
        ],
        "result": {
            "name": "runSubmitResult",
            "schema": { "$ref": "schema.json#/$defs/RunSubmitResult" }
        }
    })
}

fn run_list_method() -> Value {
    json!({
        "paramStructure": "by-name",
        "params": [],
        "result": {
            "name": "runListResult",
            "schema": { "$ref": "schema.json#/$defs/RunListResult" }
        }
    })
}

fn run_status_method() -> Value {
    run_id_method::<RunStatusParams>("runStatusResult", "RunStatusResult")
}

fn run_force_method() -> Value {
    run_id_method::<RunForceParams>("runForceResult", "RunForceResult")
}

fn run_id_method<P: schemars::JsonSchema>(result_name: &str, result_type: &str) -> Value {
    let schema = serde_json::to_value(schema_for!(P))
        .expect("native-v2 run parameter JSON Schema serialization must succeed");
    json!({
        "paramStructure": "by-name",
        "params": [{
            "name": "runId", "required": true,
            "schema": property_schema(&schema, "runId")
        }],
        "result": {
            "name": result_name,
            "schema": { "$ref": format!("schema.json#/$defs/{result_type}") }
        }
    })
}

fn run_watch_method() -> Value {
    let schema = serde_json::to_value(schema_for!(RunWatchParams))
        .expect("run watch parameter JSON Schema serialization must succeed");
    json!({
        "paramStructure": "by-name",
        "params": [
            { "name": "runId", "required": true, "schema": property_schema(&schema, "runId") },
            { "name": "fromCursor", "required": false, "schema": property_schema(&schema, "fromCursor") }
        ],
        "result": {
            "name": "runWatchResult",
            "schema": { "$ref": "schema.json#/$defs/RunWatchResult" }
        }
    })
}

fn run_logs_method() -> Value {
    let schema = serde_json::to_value(schema_for!(RunLogsParams))
        .expect("run logs parameter JSON Schema serialization must succeed");
    json!({
        "paramStructure": "by-name",
        "params": [
            { "name": "runId", "required": true, "schema": property_schema(&schema, "runId") },
            { "name": "fromCursor", "required": false, "schema": property_schema(&schema, "fromCursor") },
            { "name": "execution", "required": false, "schema": property_schema(&schema, "execution") }
        ],
        "result": {
            "name": "runLogsResult",
            "schema": { "$ref": "schema.json#/$defs/RunLogsResult" }
        }
    })
}

fn run_attach_method() -> Value {
    let schema = serde_json::to_value(schema_for!(RunAttachParams))
        .expect("run attach parameter JSON Schema serialization must succeed");
    json!({
        "paramStructure": "by-name",
        "params": [
            { "name": "runId", "required": true, "schema": property_schema(&schema, "runId") },
            { "name": "execution", "required": true, "schema": property_schema(&schema, "execution") }
        ],
        "result": {
            "name": "runAttachResult",
            "schema": { "$ref": "schema.json#/$defs/RunAttachResult" }
        }
    })
}
