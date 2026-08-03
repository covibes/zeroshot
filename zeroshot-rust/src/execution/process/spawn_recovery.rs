use std::collections::BTreeMap;
use std::path::PathBuf;

use tokio::process::{Child, Command};

use crate::execution::driver::WorkspaceCapability;

use super::platform::{self, ProcessContainment, ProcessTreeHandle, terminate_process_tree};
use super::{
    MAX_PROCESS_ARGV_BYTES, MAX_PROCESS_ARGV_ITEMS, MAX_PROCESS_ENV_BYTES, MAX_PROCESS_ENV_ITEMS,
    MAX_PROCESS_STDIN_BYTES, ProcessRunnerError,
};

pub(super) struct SpawnRecovery {
    child: Option<Child>,
    process_tree: Option<ProcessTreeHandle>,
}

impl SpawnRecovery {
    pub(super) const fn registered() -> Self {
        Self {
            child: None,
            process_tree: None,
        }
    }

    pub(super) fn capture(&mut self, child: Child) {
        self.child = Some(child);
    }

    pub(super) fn capture_process_tree(&mut self, process_tree: ProcessTreeHandle) {
        self.process_tree = Some(process_tree);
    }

    pub(super) fn child_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("spawn recovery owns child")
    }

    pub(super) async fn recover(mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if let Some(process_tree) = self.process_tree.take() {
            let _ = terminate_process_tree(&process_tree, &mut child).await;
        } else {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }

    pub(super) fn disarm(mut self) -> (Child, ProcessTreeHandle) {
        (
            self.child.take().expect("spawn recovery owns child"),
            self.process_tree
                .take()
                .expect("spawn recovery captured tree"),
        )
    }
}

impl Drop for SpawnRecovery {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let process_tree = self.process_tree.take();
        tokio::spawn(async move {
            if let Some(process_tree) = process_tree {
                let _ = terminate_process_tree(&process_tree, &mut child).await;
            } else {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
        });
    }
}

pub(super) struct ChildCommandSpec<'a> {
    pub(super) program: &'a str,
    pub(super) argv: &'a [String],
    pub(super) environment: &'a BTreeMap<String, String>,
    pub(super) workspace: &'a WorkspaceCapability,
}

struct CollectionLimit {
    label: &'static str,
    max_items: usize,
    max_bytes: usize,
}

impl CollectionLimit {
    const fn new(label: &'static str, max_items: usize, max_bytes: usize) -> Self {
        Self {
            label,
            max_items,
            max_bytes,
        }
    }
}

pub(super) fn build_child_command(
    spec: ChildCommandSpec<'_>,
    containment: ProcessContainment,
) -> Command {
    let mut child = Command::new(spec.program);
    child.args(spec.argv);
    child.current_dir(PathBuf::from(&spec.workspace.current_dir));
    child.env_clear();
    child.envs(spec.environment.iter());
    child.stdin(std::process::Stdio::piped());
    child.stdout(std::process::Stdio::piped());
    child.stderr(std::process::Stdio::piped());
    platform::configure_process(&mut child, containment);
    child
}

pub(super) fn validate_launch_fields(
    program: &str,
    argv: &[String],
    environment: &BTreeMap<String, String>,
) -> Result<(), ProcessRunnerError> {
    validate_program(program)?;
    validate_collection(
        CollectionLimit::new("argv", MAX_PROCESS_ARGV_ITEMS, MAX_PROCESS_ARGV_BYTES),
        argv.len(),
        format_arg_bytes(program, argv)?,
    )?;
    validate_collection(
        CollectionLimit::new("environment", MAX_PROCESS_ENV_ITEMS, MAX_PROCESS_ENV_BYTES),
        environment.len(),
        total_env_bytes(environment)?,
    )
}

fn validate_program(program: &str) -> Result<(), ProcessRunnerError> {
    if program.is_empty() {
        return Err(ProcessRunnerError::InvalidCommand(
            "program must not be empty".to_owned(),
        ));
    }
    Ok(())
}

fn validate_collection(
    limit: CollectionLimit,
    items: usize,
    bytes: usize,
) -> Result<(), ProcessRunnerError> {
    if items > limit.max_items {
        return Err(ProcessRunnerError::InvalidCommand(format!(
            "{} has {} items; maximum is {}",
            limit.label, items, limit.max_items
        )));
    }
    if bytes > limit.max_bytes {
        return Err(ProcessRunnerError::InvalidCommand(format!(
            "{} is {} bytes; maximum is {}",
            limit.label, bytes, limit.max_bytes
        )));
    }
    Ok(())
}

pub(super) fn validate_stdin(stdin: &[u8]) -> Result<(), ProcessRunnerError> {
    if stdin.len() > MAX_PROCESS_STDIN_BYTES {
        return Err(ProcessRunnerError::InvalidCommand(format!(
            "stdin is {} bytes; maximum is {}",
            stdin.len(),
            MAX_PROCESS_STDIN_BYTES
        )));
    }
    Ok(())
}

fn format_arg_bytes(program: &str, argv: &[String]) -> Result<usize, ProcessRunnerError> {
    argv.iter()
        .map(String::as_str)
        .chain(std::iter::once(program))
        .try_fold(0usize, |total, value| {
            total
                .checked_add(c_string_storage_bytes(value))
                .ok_or_else(|| {
                    ProcessRunnerError::InvalidCommand("argv byte count overflowed".to_owned())
                })
        })
}

fn total_env_bytes(environment: &BTreeMap<String, String>) -> Result<usize, ProcessRunnerError> {
    environment.iter().try_fold(0usize, |total, (key, value)| {
        total
            .checked_add(c_string_storage_bytes(key))
            .and_then(|subtotal| subtotal.checked_add(value.len()))
            .and_then(|subtotal| subtotal.checked_add(1))
            .ok_or_else(|| {
                ProcessRunnerError::InvalidCommand("environment byte count overflowed".to_owned())
            })
    })
}

fn c_string_storage_bytes(value: &str) -> usize {
    value.len() + 1
}
