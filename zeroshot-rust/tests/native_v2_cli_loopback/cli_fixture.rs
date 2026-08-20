use openengine_cluster_testkit::assertions::AssertValue;

use super::*;

pub(crate) const LIVE_TARGET_PREAMBLE: &str = r#"
: "${ZEROSHOT_NATIVE_V2_LIVE_REPOSITORY:?live test repository is required}"
: "${ZEROSHOT_NATIVE_V2_LIVE_BASE:?live test base branch is required}"
"$1" target add prod --url "$2" || exit $?
"$1" target login prod || exit $?
"$1" target setup prod --repository "$ZEROSHOT_NATIVE_V2_LIVE_REPOSITORY" \
  --branch "$ZEROSHOT_NATIVE_V2_LIVE_BASE" || exit $?
"#;

pub(crate) const LOOPBACK_TARGET_PREAMBLE: &str = r#"
"$1" target add prod --url "$2" || exit $?
"$1" target login prod || exit $?
"$1" target setup prod --repository open-engine/zeroshot --branch main || exit $?
"#;

pub(crate) const WAIT_FOR_FINISHED_STATUS: &str = r#"
attempt=0
while :; do
  status=$("$1" status "$run_id" --target prod) || exit $?
  printf '%s' "$status" | grep -q '"phase":"finished"' && break
  attempt=$((attempt + 1))
  test "$attempt" -lt 100 || exit 92
  sleep 0.05
done
"#;

pub(crate) fn shell_script() -> String {
    [
        KEYRING_PREAMBLE,
        LOOPBACK_TARGET_PREAMBLE,
        r#"
detached=$(
  "$1" run --target prod --title "Loopback acceptance" \
    --runtime-config "$4" --graph "$5" --input "$6" \
    --submission-key acceptance-1 -d
) || exit $?
run_id=$(printf '%s' "$detached" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p')
test -n "$run_id" || exit 91
listed=$("$1" list --target prod) || exit $?
attempt=0
while :; do
  active=$("$1" status "$run_id" --target prod) || exit $?
  execution=$(printf '%s' "$active" | sed -n 's/.*"execution":"\([^"]*\)".*/\1/p')
  test -n "$execution" && break
  attempt=$((attempt + 1))
  test "$attempt" -lt 50 || exit 92
  sleep 0.05
done
watch_output=$(timeout --preserve-status --signal=INT 1 "$1" watch "$run_id" --target prod)
logs_output=$(timeout --preserve-status --signal=INT 1 "$1" logs "$run_id" --target prod)
attach_output=$(timeout --preserve-status --signal=INT 1 "$1" attach "$run_id" "$execution" --target prod)
forced=$("$1" force-stop "$run_id" --target prod) || exit $?
attempt=0
while :; do
  terminal=$("$1" status "$run_id" --target prod) || exit $?
  printf '%s' "$terminal" | grep -q '"phase":"finished"' && break
  attempt=$((attempt + 1))
  test "$attempt" -lt 50 || exit 93
  sleep 0.05
done
printf '%s\n' \
  "DETACHED=$detached" \
  "LIST=$listed" \
  "ACTIVE=$active" \
  "EXECUTION=$execution" \
  "WATCH=$watch_output" \
  "LOGS=$logs_output" \
  "ATTACH=$attach_output" \
  "FORCED=$forced" \
  "TERMINAL=$terminal" \
  "RUN_ID=$run_id"
"#,
    ]
    .concat()
}

pub(crate) fn live_shell_script() -> String {
    [
        KEYRING_PREAMBLE,
        LIVE_TARGET_PREAMBLE,
        r#"
live_output=$(
  "$1" run --target prod --title "Live provider acceptance" \
    --runtime-config "$4" --graph "$5" --input "$6" \
    --submission-key "$7"
) || exit $?
run_id=$(printf '%s' "$live_output" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p' | head -1)
test -n "$run_id" || exit 91
logs_output=$(timeout 10 "$1" logs "$run_id" --target prod) || true
status_output=$("$1" status "$run_id" --target prod) || exit $?
printf 'LIVE=%s\nLIVE_LOGS=%s\nLIVE_STATUS=%s\n' "$live_output" "$logs_output" "$status_output"
"#,
    ]
    .concat()
}

pub(crate) fn delivery_shell_script() -> String {
    [
        KEYRING_PREAMBLE,
        r#"
"$1" target add prod --url "$2" || exit $?
"$1" target login prod || exit $?
"$1" target setup prod --repository acme/project --branch main || exit $?
result=$(
  "$1" run --target prod --title "Delivery acceptance" \
    --runtime-config "$4" --graph "$5" --input "$6" \
    --submission-key "$7"
) || exit $?
printf 'DELIVERY=%s\n' "$result"
"#,
    ]
    .concat()
}

pub(crate) fn loss_shell_script() -> String {
    [
        KEYRING_PREAMBLE,
        LOOPBACK_TARGET_PREAMBLE,
        r#"
detached=$(
  "$1" run --target prod --title "Capsule loss acceptance" \
    --runtime-config "$4" --graph "$5" --input "$6" \
    --submission-key loss-1 -d
) || exit $?
run_id=$(printf '%s' "$detached" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p')
test -n "$run_id" || exit 91
"#,
        WAIT_FOR_FINISHED_STATUS,
        r#"
printf 'LOST=%s\nRUN_ID=%s\n' "$status" "$run_id"
"#,
    ]
    .concat()
}

pub(crate) struct CliInvocation<'a> {
    pub(crate) script: &'a str,
    pub(crate) label: &'a str,
    pub(crate) binary: &'a str,
    pub(crate) origin: &'a str,
    pub(crate) config: &'a Path,
    pub(crate) runtime: &'a Path,
    pub(crate) graph: &'a Path,
    pub(crate) input: &'a Path,
    pub(crate) extra: Option<&'a str>,
}

pub(crate) fn cli_command(invocation: CliInvocation<'_>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("dbus-run-session");
    command
        .arg("--")
        .arg("bash")
        .arg("--noprofile")
        .arg("--norc")
        .arg("-c")
        .arg(invocation.script)
        .arg(invocation.label)
        .arg(invocation.binary)
        .arg(invocation.origin)
        .arg(invocation.config)
        .arg(invocation.runtime)
        .arg(invocation.graph)
        .arg(invocation.input)
        .env("ZEROSHOT_RUST_CONFIG_DIR", invocation.config);
    if let Some(extra) = invocation.extra {
        command.arg(extra);
    }
    command
}

pub(crate) async fn run_cli_command(
    mut command: tokio::process::Command,
    deadline: Duration,
    context: &str,
) -> (String, String) {
    let output = tokio::time::timeout(deadline, command.output())
        .await
        .assert_value_with(&format!("{context} timed out"))
        .assert_value_with("dbus-run-session starts");
    let stdout = String::from_utf8(output.stdout).assert_value();
    let stderr = String::from_utf8(output.stderr).assert_value();
    assert!(
        output.status.success(),
        "{context} failed\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    (stdout, stderr)
}

pub(crate) fn cli_prerequisites_available() -> bool {
    for prerequisite in [
        "dbus-run-session",
        "gnome-keyring-daemon",
        "secret-tool",
        "timeout",
    ] {
        if std::process::Command::new(prerequisite)
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skipping native-v2 CLI loopback: {prerequisite} is unavailable");
            return false;
        }
    }
    true
}
