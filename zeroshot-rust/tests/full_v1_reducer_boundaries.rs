use openengine_cluster_protocol::{PositiveInteger, WorkerOutcome};
use openengine_cluster_server::admission::VerifiedGraph;
use serde_json::{json, Value};
use zeroshot_engine::full_v1_reducer::{
    Decision, DurableExecution, DurableExecutionState, ExecutionId, ExecutionVoidReason,
    FullV1Reducer, HistoryPosition, NodeInstanceId, ReducerError, ReductionInput,
    StructuralOccurrence, TerminalProjection,
};

#[path = "support/full_v1_reducer.rs"]
mod reducer_test_support;
use reducer_test_support::verifier;

async fn verified(root: Value, _attempts: Value) -> VerifiedGraph {
    let initial_input = root.get("state").cloned().unwrap_or_else(boundary_state);
    reducer_test_support::verified_graph(root, initial_input, false).await
}

fn step(name: &str, attempts: u64) -> Value {
    reducer_test_support::step_node(name, attempts, json!({"kind":"record","fields":{}}))
}

fn succeed(name: &str) -> Value {
    json!({"kind":"succeed","name":name,"output":{"kind":"null"},"bindings":[]})
}

fn boundary_state() -> Value {
    json!({
        "kind":"record",
        "fields":{
            "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
        }
    })
}

fn seq(children: Vec<Value>) -> Value {
    json!({
        "kind":"seq","name":"root","state":boundary_state(),
        "children":children,"promotedStatePaths":[]
    })
}

struct ExecutionSpec<'a> {
    id: u64,
    node_instance: u64,
    node: &'a str,
    indices: Vec<u64>,
    attempt: u64,
    settled_at: u64,
}

impl<'a> ExecutionSpec<'a> {
    fn new(id: u64, node_instance: u64, node: &'a str) -> Self {
        Self {
            id,
            node_instance,
            node,
            indices: Vec::new(),
            attempt: 1,
            settled_at: 1,
        }
    }

    fn indices(mut self, indices: Vec<u64>) -> Self {
        self.indices = indices;
        self
    }

    fn attempt(mut self, attempt: u64) -> Self {
        self.attempt = attempt;
        self
    }

    fn settled_at(mut self, settled_at: u64) -> Self {
        self.settled_at = settled_at;
        self
    }
}

fn execution(spec: ExecutionSpec<'_>, outcome: WorkerOutcome) -> DurableExecution {
    DurableExecution {
        dispatch_position: HistoryPosition::new(spec.settled_at - 1).assert_value(),
        node_instance: NodeInstanceId::new(spec.node_instance).assert_value(),
        execution: ExecutionId::new(spec.id).assert_value(),
        occurrence: StructuralOccurrence {
            node: spec.node.parse().assert_value(),
            map_indices: spec.indices,
        },
        attempt: PositiveInteger::new(spec.attempt).assert_value(),
        input: Value::Null,
        state: DurableExecutionState::Settled {
            position: HistoryPosition::new(spec.settled_at).assert_value(),
            outcome,
        },
    }
}

fn success() -> WorkerOutcome {
    WorkerOutcome::Verified {
        output: json!({}),
        artifacts: Vec::new(),
    }
}

fn verdict(label: &str) -> WorkerOutcome {
    WorkerOutcome::Verifier {
        output: json!({}),
        signals: [(
            "verdict".parse().assert_value(),
            label.parse().assert_value(),
        )]
        .into_iter()
        .collect(),
        diagnostic: json!({}),
        artifacts: Vec::new(),
    }
}

fn input<'a>(initial: &'a Value, executions: &'a [DurableExecution]) -> ReductionInput<'a> {
    ReductionInput {
        initial_input: initial,
        executions,
        next_node_instance: executions
            .iter()
            .map(|item| item.node_instance.get())
            .max()
            .unwrap_or(0)
            + 1,
        next_execution: executions
            .iter()
            .map(|item| item.execution.get())
            .max()
            .unwrap_or(0)
            + 1,
    }
}

#[path = "full_v1_reducer_boundaries/cases_1.rs"]
mod cases_1;
#[path = "full_v1_reducer_boundaries/cases_2.rs"]
mod cases_2;
#[path = "full_v1_reducer_boundaries/cases_3.rs"]
mod cases_3;
#[path = "full_v1_reducer_boundaries/cases_4.rs"]
mod cases_4;

use openengine_cluster_testkit::assertions::{AssertValue};
