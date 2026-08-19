use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use openengine_cluster_protocol::{GraphSpec, NodeInstructions, NodeName, RunId, WorkerRef};
use serde_json::{Value, json};

use crate::native_v2_admission::NativeV2Admission;
use crate::native_v2_contract::{
    self, AdmittedRun, ExecutionId, ExecutionRef, NodeInstanceId, NodeInvocation,
    NodeRuntimeBinding, RunSubmission, GIT_DELIVERY_MERGE_WORKER_REF,
};
use crate::native_v2_delivery::{
    DELIVERY_CI_FAILED_LABEL, DELIVERY_CONFLICT_LABEL, DELIVERY_MERGED_LABEL, DeliveryMode,
};
use crate::native_v2_delivery::contract::delivery_result_schema;
use crate::native_v2_runner::{NodeRunRequest, ResolvedEnvironment};

static NEXT_TEMPORARY_DIRECTORY: AtomicU64 = AtomicU64::new(1);

pub(crate) struct TestDirectory(PathBuf);

impl TestDirectory {
    pub(crate) fn new(label: &str) -> Self {
        let serial = NEXT_TEMPORARY_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "zeroshot-native-v2-{label}-{}-{serial}",
            std::process::id()
        ));
        fs::create_dir_all(&path).assert_value_with("create temporary test directory");
        Self(path)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }

    pub(crate) fn child(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    pub(crate) fn read(&self, name: &str) -> String {
        fs::read_to_string(self.child(name)).assert_value_with("read test file")
    }

    pub(crate) fn write(&self, name: &str, contents: &str) -> PathBuf {
        let path = self.child(name);
        fs::write(&path, contents).assert_value_with("write test file");
        path
    }

    pub(crate) fn write_executable(&self, name: &str, contents: &str) -> PathBuf {
        let path = self.child(name);
        fs::write(&path, contents).assert_value_with("write test executable");
        let mut permissions = fs::metadata(&path)
            .assert_value_with("read test executable metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).assert_value_with("make test executable");
        path
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn environment_name(value: &str) -> native_v2_contract::EnvironmentVariableName {
    native_v2_contract::EnvironmentVariableName::new(value)
        .assert_value_with("environment variable name")
}

pub(crate) async fn admit(submission: RunSubmission) -> AdmittedRun {
    NativeV2Admission
        .admit(submission)
        .await
        .assert_value_with("admit test graph")
}

pub(crate) struct NodeRequestFixture<'a> {
    pub(crate) run_id: &'a str,
    pub(crate) node: &'a str,
    pub(crate) node_instance: u64,
    pub(crate) execution: u64,
    pub(crate) worker: &'a str,
    pub(crate) instructions: &'a str,
    pub(crate) input: Value,
    pub(crate) binding: NodeRuntimeBinding,
    pub(crate) environment: BTreeMap<native_v2_contract::EnvironmentVariableName, String>,
}

impl NodeRequestFixture<'_> {
    pub(crate) fn into_request(self) -> NodeRunRequest {
        let environment = ResolvedEnvironment::exact(&self.binding, self.environment)
            .assert_value_with("resolve test environment");
        NodeRunRequest {
            invocation: NodeInvocation {
                reference: ExecutionRef {
                    run_id: RunId::new(self.run_id),
                    node: NodeName::new(self.node).assert_value_with("node name"),
                    node_instance: NodeInstanceId::new(self.node_instance)
                        .assert_value_with("node instance"),
                    execution: ExecutionId::new(self.execution).assert_value_with("execution"),
                },
                worker: WorkerRef::new(self.worker).assert_value_with("worker reference"),
                instructions: Some(
                    NodeInstructions::new(self.instructions).assert_value_with("node instructions"),
                ),
                input: self.input,
                binding: self.binding,
            },
            environment,
        }
    }
}

use openengine_cluster_testkit::assertions::{AssertValue};

pub(crate) fn full_graph(children: Vec<Value>) -> GraphSpec {
    serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{"kind":"null"},
        "policy":{"policy":"policy.native-v2@1","default":"deny"},
        "root":{
            "kind":"seq",
            "name":"root",
            "state":{"kind":"null"},
            "children":children,
            "promotedStatePaths":[]
        }
    }))
    .assert_value_with("test graph")
}

pub(crate) fn success_node_named(name: &str) -> Value {
    Value::Object(serde_json::Map::from_iter([
        ("kind".to_owned(), Value::String("succeed".to_owned())),
        ("name".to_owned(), Value::String(name.to_owned())),
        ("output".to_owned(), json!({"kind": "null"})),
        ("bindings".to_owned(), Value::Array(Vec::new())),
    ]))
}

pub(crate) fn success_node() -> Value {
    success_node_named("done")
}

pub(crate) fn git_delivery_node() -> Value {
    serde_json::json!({
        "kind":"verifier","name":"deliver","worker":GIT_DELIVERY_MERGE_WORKER_REF,
        "input":{"kind":"null"},"output":delivery_result_schema(DeliveryMode::Merge)
            .assert_value_with("delivery result schema"),
        "inputBindings":[],"writeBindings":[],"timeoutMs":1000,"attempts":1,
        "signals":{"delivery":[
            DELIVERY_MERGED_LABEL,
            DELIVERY_CONFLICT_LABEL,
            DELIVERY_CI_FAILED_LABEL
        ]},
        "diagnostic":{"kind":"string"}
    })
}

pub(crate) fn git(directory: &Path, arguments: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(arguments)
        .status()
        .assert_value_with("run git");
    assert!(status.success(), "git command failed: {arguments:?}");
}

pub(crate) fn git_output(directory: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(arguments)
        .output()
        .assert_value_with("run git");
    assert!(output.status.success(), "git command failed: {arguments:?}");
    String::from_utf8(output.stdout)
        .assert_value_with("git output is UTF-8")
        .trim()
        .to_owned()
}

pub(crate) fn path_text(path: &Path) -> &str {
    path.to_str().assert_value_with("test path is UTF-8")
}

pub(crate) struct TestGitRepository {
    pub(crate) root: TestDirectory,
    pub(crate) remote: PathBuf,
    pub(crate) workspace: PathBuf,
    pub(crate) base: String,
}

impl TestGitRepository {
    pub(crate) fn candidate() -> Self {
        Self::new("candidate", "Candidate Test", "candidate@example.invalid")
    }

    pub(crate) fn delivery() -> Self {
        let repository = Self::new("delivery", "Test", "test@example.invalid");
        fs::write(repository.workspace.join("result.txt"), "delivered\n")
            .assert_value_with("write delivery result");
        repository
    }

    fn new(label: &str, user_name: &str, user_email: &str) -> Self {
        let root = TestDirectory::new(label);
        let remote = root.child("remote.git");
        let seed = root.child("seed");
        let workspace = root.child("workspace");
        git(root.path(), &["init", "--bare", path_text(&remote)]);
        git(root.path(), &["init", path_text(&seed)]);
        fs::write(seed.join("README.md"), "base\n").assert_value_with("write seed file");
        git(&seed, &["add", "README.md"]);
        git(
            &seed,
            &[
                "-c",
                &format!("user.name={user_name}"),
                "-c",
                &format!("user.email={user_email}"),
                "commit",
                "-m",
                "base",
            ],
        );
        git(&seed, &["branch", "-M", "main"]);
        git(&seed, &["remote", "add", "origin", path_text(&remote)]);
        git(&seed, &["push", "origin", "main"]);
        git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(
            root.path(),
            &["clone", path_text(&remote), path_text(&workspace)],
        );
        let base = git_output(&workspace, &["rev-parse", "HEAD"]);
        Self {
            root,
            remote,
            workspace,
            base,
        }
    }
}
