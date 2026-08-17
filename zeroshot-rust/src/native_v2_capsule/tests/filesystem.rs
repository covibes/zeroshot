use super::*;

fn temporary_root() -> PathBuf {
    let sequence = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "zeroshot-capsule-permissions-{}-{sequence}",
        std::process::id()
    ))
}

#[test]
fn capsule_filesystem_rejects_nested_workspace_and_runtime_roots() {
    let root = temporary_root();
    fs::create_dir(&root).assert_value();
    let pool = HostedProcessPool::new(31_002, 31_002, 32_000, 32_000).assert_value();

    let workspace = root.join("workspace-parent");
    fs::create_dir(&workspace).assert_value();
    let nested_runtime = workspace.join("runtime-home");
    assert!(matches!(
        prepare_capsule_filesystem(CapsuleFilesystemSpec {
            workspace: &workspace,
            runtime_home: &nested_runtime,
            process_pool: pool,
        }),
        Err(CapsuleFilesystemError::InvalidLayout)
    ));

    let runtime_home = root.join("runtime-parent");
    fs::create_dir(&runtime_home).assert_value();
    let nested_workspace = runtime_home.join("workspace");
    fs::create_dir(&nested_workspace).assert_value();
    assert!(matches!(
        prepare_capsule_filesystem(CapsuleFilesystemSpec {
            workspace: &nested_workspace,
            runtime_home: &runtime_home,
            process_pool: pool,
        }),
        Err(CapsuleFilesystemError::InvalidLayout)
    ));

    fs::remove_dir_all(root).assert_value();
}

#[cfg(target_os = "linux")]
fn run_as(uid: u32, gid: u32, program: &str, arguments: &[&Path]) -> bool {
    use std::os::unix::process::CommandExt;

    Command::new(program)
        .args(arguments)
        .uid(uid)
        .gid(gid)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Run this exact test as root (the cloud capsule's launch identity) to exercise real UID checks.
#[test]
#[cfg(target_os = "linux")]
fn root_capsule_permissions_enforce_writer_and_parallel_verifier_boundaries() {
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("root-only capsule permission gate skipped outside the capsule identity");
        return;
    }
    let root = temporary_root();
    fs::create_dir(&root).assert_value();
    let workspace = root.join("workspace");
    let runtime_home = root.join("runtime-home");
    let pool = HostedProcessPool::new(31_002, 31_002, 32_000, 32_000).assert_value();
    assert!(matches!(
        prepare_capsule_filesystem(CapsuleFilesystemSpec {
            workspace: &workspace,
            runtime_home: &workspace.join("."),
            process_pool: pool,
        }),
        Err(CapsuleFilesystemError::InvalidLayout)
    ));
    let prepared = prepare_capsule_filesystem(CapsuleFilesystemSpec {
        workspace: &workspace,
        runtime_home: &runtime_home,
        process_pool: pool,
    })
    .assert_value();
    let writer = pool.identity(HostedProcessScope::Writer).assert_value();
    let left = pool
        .identity(HostedProcessScope::VerifierExecution(1))
        .assert_value();
    let right = pool
        .identity(HostedProcessScope::VerifierExecution(2))
        .assert_value();

    assert_prepared_metadata(&prepared, &writer);
    assert_workspace_access(&prepared, &writer, &left, &right);
    assert_private_home_isolation(&prepared, &left, &right);
    fs::remove_dir_all(root).assert_value();
}

#[cfg(target_os = "linux")]
fn assert_prepared_metadata(
    prepared: &CapsuleFilesystem,
    writer: &crate::execution::process::HostedProcessIdentity,
) {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let workspace_metadata = fs::metadata(&prepared.workspace).assert_value();
    assert_eq!(workspace_metadata.uid(), writer.uid());
    assert_eq!(workspace_metadata.permissions().mode() & 0o777, 0o755);
    let runtime_metadata = fs::metadata(&prepared.runtime_home).assert_value();
    assert_eq!(runtime_metadata.uid(), 0);
    assert_eq!(runtime_metadata.permissions().mode() & 0o777, 0o711);
}

#[cfg(target_os = "linux")]
fn assert_workspace_access(
    prepared: &CapsuleFilesystem,
    writer: &crate::execution::process::HostedProcessIdentity,
    left: &crate::execution::process::HostedProcessIdentity,
    right: &crate::execution::process::HostedProcessIdentity,
) {
    let writer_directory = prepared.workspace.join("writer-tree");
    assert!(run_as(
        writer.uid(),
        writer.gid(),
        "/bin/mkdir",
        &[&writer_directory]
    ));
    let writer_file = writer_directory.join("product.txt");
    assert!(run_as(
        writer.uid(),
        writer.gid(),
        "/usr/bin/touch",
        &[&writer_file]
    ));
    assert!(!run_as(
        left.uid(),
        left.gid(),
        "/usr/bin/touch",
        &[&writer_file]
    ));
    assert!(!run_as(
        right.uid(),
        right.gid(),
        "/usr/bin/touch",
        &[&writer_directory.join("verifier-created")]
    ));
    assert!(!run_as(
        left.uid(),
        left.gid(),
        "/bin/mkdir",
        &[&prepared.runtime_home.join("escaped")]
    ));
}

#[cfg(target_os = "linux")]
fn assert_private_home_isolation(
    prepared: &CapsuleFilesystem,
    left: &crate::execution::process::HostedProcessIdentity,
    right: &crate::execution::process::HostedProcessIdentity,
) {
    let left_home = left
        .prepare_private_home(&prepared.runtime_home)
        .assert_value();
    let right_home = right
        .prepare_private_home(&prepared.runtime_home)
        .assert_value();
    assert_ne!(left.uid(), right.uid());
    let mut left_child = verifier_isolation_child(left.uid(), left.gid(), &left_home, &right_home);
    let mut right_child =
        verifier_isolation_child(right.uid(), right.gid(), &right_home, &left_home);
    assert!(left_child.wait().assert_value().success());
    assert!(right_child.wait().assert_value().success());
    assert!(left_home.join("own").exists());
    assert!(right_home.join("own").exists());
    assert!(!left_home.join("stolen").exists());
    assert!(!right_home.join("stolen").exists());
}

#[cfg(target_os = "linux")]
fn verifier_isolation_child(
    uid: u32,
    gid: u32,
    own_home: &Path,
    peer_home: &Path,
) -> std::process::Child {
    use std::os::unix::process::CommandExt;

    Command::new("/bin/sh")
        .arg("-c")
        .arg("touch \"$OWN/own\"; ! touch \"$PEER/stolen\"")
        .env_clear()
        .env("OWN", own_home)
        .env("PEER", peer_home)
        .uid(uid)
        .gid(gid)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .assert_value()
}

use openengine_cluster_testkit::assertions::{AssertValue};
