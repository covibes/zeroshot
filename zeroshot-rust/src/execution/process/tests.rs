use std::{fs, path::Path};

use openengine_cluster_testkit::assertions::AssertValue;

use super::{HostedProcessPool, HostedProcessScope, write_new_file};
use crate::native_v2_candidate::test_support::TestDirectory;

#[test]
fn hosted_scopes_keep_loop_sessions_stable_and_executions_disjoint() {
    let pool = HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).assert_value();
    let loop_scope = HostedProcessScope::VerifierNodeInstance(7);
    let repeated = pool.identity(loop_scope).assert_value();
    let first_execution = pool
        .identity(HostedProcessScope::VerifierExecution(7))
        .assert_value();
    let second_execution = pool
        .identity(HostedProcessScope::VerifierExecution(8))
        .assert_value();

    assert_eq!(
        pool.identity(loop_scope).assert_value().uid(),
        repeated.uid()
    );
    assert_ne!(repeated.uid(), first_execution.uid());
    assert_ne!(first_execution.uid(), second_execution.uid());
    assert_eq!(
        loop_scope.private_home(Path::new("/runtime")),
        Path::new("/runtime/verifier-node-instance-7")
    );
    assert_eq!(
        HostedProcessScope::VerifierExecution(7).private_home(Path::new("/runtime")),
        Path::new("/runtime/verifier-execution-7")
    );
    assert!(
        pool.identity(HostedProcessScope::VerifierExecution(0))
            .is_err()
    );
}

#[test]
fn active_run_slots_are_disjoint_from_source_and_each_other() {
    let host = HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).assert_value();
    let first = host.active_run_slot(0, 65_536).assert_value();
    let second = host.active_run_slot(1, 65_536).assert_value();

    assert_eq!(writer_identity(host), (10_002, 10_002));
    assert_eq!(writer_identity(first), (20_000, 10_002));
    assert_eq!(writer_identity(second), (151_073, 10_002));
    assert_eq!(
        first
            .identity(HostedProcessScope::VerifierExecution(65_536))
            .assert_value()
            .uid(),
        151_072
    );
    assert!(host.active_run_slot(u32::MAX, 65_536).is_err());
    let sentinel = HostedProcessPool::new(1, 1, u32::MAX - 4, 2).assert_value();
    assert!(sentinel.active_run_slot(0, 2).is_err());
}

#[test]
fn new_file_writes_are_exclusive_and_complete() {
    let directory = TestDirectory::new("process-new-file");
    let path = directory.child("value");
    write_new_file(&path, b"complete", 0o600).assert_value();
    assert_eq!(fs::read(&path).assert_value(), b"complete");
    assert!(write_new_file(&path, b"replacement", 0o600).is_err());
    assert_eq!(fs::read(path).assert_value(), b"complete");
}

fn writer_identity(pool: HostedProcessPool) -> (u32, u32) {
    let identity = pool.identity(HostedProcessScope::Writer).assert_value();
    (identity.uid(), identity.gid())
}
