use openengine_cluster_protocol::{GraphSpec, PositiveInteger, WorkerOutcome};
use openengine_cluster_server::admission::{GraphVerifier, VerifiedGraph};
use openengine_cluster_server::graph_verifier::ProductionGraphVerifier;
use serde_json::{json, Value};
use zeroshot_engine::full_v1_reducer::{
    Decision, DurableExecution, DurableExecutionState, ExecutionId, ExecutionVoidReason,
    FullV1Reducer, HistoryPosition, NodeInstanceId, ReducerError, Reduction, ReductionInput,
    StructuralOccurrence, TerminalProjection,
};

#[path = "support/full_v1_reducer.rs"]
mod reducer_test_support;
use reducer_test_support::{verifier, TestWorkers};

async fn verified(root: Value, _attempts: Value) -> VerifiedGraph {
    let initial_input = root
        .get("state")
        .cloned()
        .unwrap_or_else(|| json!({"kind":"record","fields":{}}));
    reducer_test_support::verified_graph(root, initial_input, true).await
}

fn step(name: &str, attempts: u64) -> Value {
    reducer_test_support::step_node(
        name,
        attempts,
        json!({"kind":"record","fields":{
            "value":{"type":{"kind":"integer"},"required":true}
        }}),
    )
}

fn promoted_integer_step(name: &str, target: &str) -> Value {
    promoted_integer_step_at_path(name, &[target])
}

fn promoted_integer_step_at_path(name: &str, target: &[&str]) -> Value {
    json!({
        "kind":"step","name":name,"worker":"worker.test@1",
        "input":{"kind":"null"},
        "output":{"kind":"record","fields":{"value":{"type":{"kind":"integer"},"required":true}}},
        "inputBindings":[],
        "writeBindings":[{"value":{"node":name,"channel":"out","path":["value"]},"target":target}],
        "timeoutMs":1,"attempts":1
    })
}

fn succeed(name: &str) -> Value {
    json!({"kind":"succeed","name":name,"output":{"kind":"null"},"bindings":[]})
}

fn sequence(name: &str, children: Vec<Value>) -> Value {
    json!({
        "kind":"seq", "name":name, "state":{"kind":"record","fields":{}},
        "children":children, "promotedStatePaths":[]
    })
}

fn required_array_record(fields: &[(&str, &str)]) -> Value {
    let fields = fields
        .iter()
        .map(|(name, item_kind)| {
            (
                (*name).to_owned(),
                json!({
                    "type":{"kind":"array","items":{"kind":item_kind}},
                    "required":true
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    json!({"kind":"record","fields":fields})
}

struct ParallelSequenceSpec<'a> {
    root_name: &'a str,
    parallel_name: &'a str,
    branches: Vec<Value>,
    join: Value,
    terminal_name: &'a str,
    attempts: Value,
}

async fn verified_parallel_sequence(spec: ParallelSequenceSpec<'_>) -> VerifiedGraph {
    verified(
        sequence(
            spec.root_name,
            vec![
                json!({
                    "kind":"par", "name":spec.parallel_name,
                    "state":{"kind":"record","fields":{}},
                    "branches":spec.branches, "promotedStatePaths":[], "join":spec.join
                }),
                succeed(spec.terminal_name),
            ],
        ),
        spec.attempts,
    )
    .await
}

struct SettledSpec<'a> {
    execution: u64,
    node_instance: u64,
    node: &'a str,
    map_indices: Vec<u64>,
    attempt: u64,
    position: u64,
}

impl<'a> SettledSpec<'a> {
    fn new(execution: u64, node_instance: u64, node: &'a str) -> Self {
        Self {
            execution,
            node_instance,
            node,
            map_indices: Vec::new(),
            attempt: 1,
            position: 1,
        }
    }

    fn map_indices(mut self, map_indices: Vec<u64>) -> Self {
        self.map_indices = map_indices;
        self
    }

    fn attempt(mut self, attempt: u64) -> Self {
        self.attempt = attempt;
        self
    }

    fn position(mut self, position: u64) -> Self {
        self.position = position;
        self
    }
}

fn settled(spec: SettledSpec<'_>, outcome: WorkerOutcome) -> DurableExecution {
    DurableExecution {
        dispatch_position: HistoryPosition::new(spec.position.saturating_sub(1)).assert_value(),
        node_instance: NodeInstanceId::new(spec.node_instance).assert_value(),
        execution: ExecutionId::new(spec.execution).assert_value(),
        occurrence: StructuralOccurrence {
            node: spec.node.parse().assert_value(),
            map_indices: spec.map_indices,
        },
        attempt: PositiveInteger::new(spec.attempt).assert_value(),
        input: Value::Null,
        state: DurableExecutionState::Settled {
            position: HistoryPosition::new(spec.position).assert_value(),
            outcome,
        },
    }
}

fn active(execution: u64, node_instance: u64, node: &str, position: u64) -> DurableExecution {
    DurableExecution {
        dispatch_position: HistoryPosition::new(position).assert_value(),
        node_instance: NodeInstanceId::new(node_instance).assert_value(),
        execution: ExecutionId::new(execution).assert_value(),
        occurrence: StructuralOccurrence {
            node: node.parse().assert_value(),
            map_indices: Vec::new(),
        },
        attempt: PositiveInteger::new(1).assert_value(),
        input: Value::Null,
        state: DurableExecutionState::Active,
    }
}

fn success(value: i64) -> WorkerOutcome {
    WorkerOutcome::Verified {
        output: json!({"value":value}),
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

fn reduce(graph: &VerifiedGraph, input: &Value, executions: &[DurableExecution]) -> Reduction {
    FullV1Reducer::new(graph)
        .reduce(ReductionInput {
            initial_input: input,
            executions,
            next_node_instance: executions
                .iter()
                .map(|execution| execution.node_instance.get())
                .max()
                .unwrap_or(0)
                + 1,
            next_execution: executions
                .iter()
                .map(|execution| execution.execution.get())
                .max()
                .unwrap_or(0)
                + 1,
        })
        .assert_value()
}

#[path = "full_v1_reducer/cases_1.rs"]
mod cases_1;
#[path = "full_v1_reducer/cases_2.rs"]
mod cases_2;
#[path = "full_v1_reducer/cases_3.rs"]
mod cases_3;
#[path = "full_v1_reducer/cases_4.rs"]
mod cases_4;

use openengine_cluster_testkit::assertions::{AssertValue};
