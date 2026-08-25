use std::process::{Command, Output};

use openengine_cluster_testkit::assertions::AssertValue;
use zeroshot_engine::native_v2_admission::{CLAUDE_MODELS, CODEX_MODELS};
use zeroshot_engine::native_v2_contract::{
    ClaudeProvider, CodexProvider, ReasoningEffort, RunSize, SessionScope,
};

macro_rules! exhaustive_values {
    ($type:ty => [$($variant:path),+ $(,)?]) => {{
        let values = [$($variant),+];
        let exhaustive = |value: $type| match value {
            $($variant => ()),+
        };
        for value in values {
            exhaustive(value);
        }
        values
    }};
}

const HELP_PATHS: &[&[&str]] = &[
    &[],
    &["target"],
    &["target", "add"],
    &["target", "login"],
    &["target", "setup"],
    &["target", "serve"],
    &["template"],
    &["template", "list"],
    &["template", "show"],
    &["run"],
    &["list"],
    &["status"],
    &["watch"],
    &["logs"],
    &["attach"],
    &["force-stop"],
];

#[test]
fn short_and_long_help_cover_the_complete_public_command_tree() {
    for path in HELP_PATHS {
        for flag in ["-h", "--help"] {
            let mut arguments = path.to_vec();
            arguments.push(flag);
            assert_help(&arguments, path);
        }
    }
}

#[test]
fn help_subcommand_reaches_every_group_and_operational_command() {
    for path in HELP_PATHS.iter().copied().filter(|path| !path.is_empty()) {
        let arguments = std::iter::once("help")
            .chain(path.iter().copied())
            .collect::<Vec<_>>();
        assert_help(&arguments, path);
    }
}

#[test]
fn help_explains_runtime_configuration() {
    let run = successful_stdout(&["run", "--help"]);
    assert_prose(
        &run,
        &[
            "runtime configuration",
            r#""harness": "codex""#,
            r#""provider": "openrouter""#,
            r#""env": ["openrouter_api_key"]"#,
            "env lists variable names copied from the submitting process",
            "never put values in this file",
            "zeroshot-rust template show template",
            "omit the template-owned delivery binding",
        ],
    );

    let codex_providers = serialized_names(&exhaustive_values!(CodexProvider => [
        CodexProvider::OpenAi,
        CodexProvider::OpenRouter,
    ]));
    let claude_providers = serialized_names(&exhaustive_values!(ClaudeProvider => [
        ClaudeProvider::Anthropic,
        ClaudeProvider::OpenRouter,
    ]));
    let sizes = serialized_names(&exhaustive_values!(RunSize => [
        RunSize::Tiny,
        RunSize::Small,
        RunSize::Standard,
        RunSize::Large,
    ]));
    let efforts = serialized_names(&exhaustive_values!(ReasoningEffort => [
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
        ReasoningEffort::Xhigh,
        ReasoningEffort::Max,
    ]));
    let session_scopes = serialized_names(&exhaustive_values!(SessionScope => [
        SessionScope::Execution,
        SessionScope::NodeInstance,
    ]));
    let contract_prose = [
        format!(
            "harness/provider pairs: codex: {} claude: {} sizes are {}.",
            prose_list(codex_providers, "or"),
            prose_list(claude_providers, "or"),
            prose_list(sizes, "and")
        ),
        format!(
            "codex models are {}. claude models are {}.",
            prose_list(CODEX_MODELS.iter().map(|model| model.id.to_owned()), "and"),
            prose_list(CLAUDE_MODELS.iter().map(|model| model.id.to_owned()), "and")
        ),
        format!(
            "optional fields are effort ({} when supported), sessionscope ({}), and env.",
            prose_list(efforts, "or"),
            prose_list(session_scopes, "or")
        ),
    ];
    for expected in &contract_prose {
        assert_prose(&run, &[expected]);
    }
}

#[test]
fn help_explains_delivery_authentication_and_local_run_safety() {
    let run = successful_stdout(&["run", "--help"]);
    assert_prose(
        &run,
        &[
            "when --target is omitted",
            "current local repository",
            "foreground run follows ndjson events until completion",
            "-d, --detach",
            "return after submission",
            "ctrl-c also detaches from observation without stopping the run",
            "--ship",
            "materialize merge delivery for the software-change template",
            "named-target runs send gh_token",
            "source checkout and git delivery",
            "providers receive it only when the runtime declares gh_token",
        ],
    );

    let run_short = successful_stdout(&["run", "-h"]);
    assert_prose(
        &run_short,
        &[
            "--target",
            "if omitted, run locally",
            "named targets receive gh_token when set",
        ],
    );

    let target_add = successful_stdout(&["target", "add", "--help"]);
    assert_prose(
        &target_add,
        &[
            "--direct",
            "unauthenticated direct access",
            "hosted authentication",
        ],
    );

    let target_setup = successful_stdout(&["target", "setup", "--help"]);
    assert_prose(
        &target_setup,
        &[
            "local profile for a named target",
            "only the local named-target registry",
            "does not configure the remote target",
        ],
    );

    for flag in ["-h", "--help"] {
        let target_serve = successful_stdout(&["target", "serve", flag]);
        assert_prose(
            &target_serve,
            &[
                "unauthenticated unless --bootstrap-key-file is set",
                "one-time key file consumed and removed at startup",
            ],
        );
    }

    let target_serve = successful_stdout(&["target", "serve", "--help"]);
    assert_prose(
        &target_serve,
        &[
            "--bootstrap-key-file",
            "private authenticated access",
            "consumes and removes",
            "unauthenticated direct connections",
        ],
    );
}

#[test]
fn help_and_version_aliases_remain_available() {
    for arguments in [
        [].as_slice(),
        ["-h"].as_slice(),
        ["--help"].as_slice(),
        ["help"].as_slice(),
    ] {
        let help = successful_stdout(arguments);
        assert_prose(&help, &["usage: zeroshot-rust", "commands:"]);
    }

    let version = successful_stdout(&["--version"]);
    assert_eq!(successful_stdout(&["-V"]), version);
    assert_eq!(successful_stdout(&["version"]), version);
    assert!(
        version.trim().starts_with("zeroshot-rust "),
        "unexpected version output: {version:?}"
    );
}

#[test]
fn typos_report_a_suggestion_and_contextual_usage() {
    assert_contextual_error(
        &["rum"],
        "a similar subcommand exists: 'run'",
        "usage: zeroshot-rust [command]",
    );
    assert_contextual_error(
        &["target", "logn"],
        "a similar subcommand exists: 'login'",
        "usage: zeroshot-rust target <command>",
    );
    assert_contextual_error(
        &["run", "--titel", "audit"],
        "a similar argument exists: '--title'",
        "usage: zeroshot-rust run",
    );
}

fn assert_help(arguments: &[&str], path: &[&str]) {
    let output = invoke(arguments);
    assert!(
        output.status.success(),
        "help command {arguments:?} failed\nstdout:\n{}\nstderr:\n{}",
        utf8(&output.stdout),
        utf8(&output.stderr)
    );
    let stdout = utf8(&output.stdout);
    let expected_usage = if path.is_empty() {
        "Usage: zeroshot-rust".to_owned()
    } else {
        format!("Usage: zeroshot-rust {}", path.join(" "))
    };
    assert!(
        stdout.contains(&expected_usage),
        "help command {arguments:?} did not show contextual usage {expected_usage:?}\nstdout:\n{stdout}"
    );
    assert!(
        output.stderr.is_empty(),
        "help command {arguments:?} unexpectedly wrote stderr:\n{}",
        utf8(&output.stderr)
    );
}

fn assert_contextual_error(arguments: &[&str], suggestion: &str, usage: &str) {
    let output = invoke(arguments);
    assert!(
        !output.status.success(),
        "invalid command {arguments:?} unexpectedly succeeded\nstdout:\n{}\nstderr:\n{}",
        utf8(&output.stdout),
        utf8(&output.stderr)
    );
    let stderr = normalized(&utf8(&output.stderr));
    assert!(
        stderr.contains(suggestion),
        "invalid command {arguments:?} did not suggest {suggestion:?}\nstderr:\n{stderr}"
    );
    assert!(
        stderr.contains(usage),
        "invalid command {arguments:?} did not show contextual usage {usage:?}\nstderr:\n{stderr}"
    );
}

fn assert_prose(output: &str, expected: &[&str]) {
    let output = normalized(output);
    for phrase in expected {
        assert!(
            output.contains(phrase),
            "help did not contain {phrase:?}\nnormalized output:\n{output}"
        );
    }
}

fn successful_stdout(arguments: &[&str]) -> String {
    let output = invoke(arguments);
    assert!(
        output.status.success(),
        "command {arguments:?} failed\nstdout:\n{}\nstderr:\n{}",
        utf8(&output.stdout),
        utf8(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "command {arguments:?} unexpectedly wrote stderr:\n{}",
        utf8(&output.stderr)
    );
    utf8(&output.stdout)
}

fn invoke(arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_zeroshot-rust"))
        .args(arguments)
        .output()
        .assert_value_with("zeroshot-rust command should be invocable")
}

fn utf8(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec())
        .assert_value_with("zeroshot-rust output should be valid UTF-8")
}

fn normalized(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn serialized_names<T: serde::Serialize>(values: &[T]) -> Vec<String> {
    values
        .iter()
        .map(|value| {
            serde_json::to_value(value)
                .assert_value()
                .as_str()
                .assert_value()
                .to_owned()
        })
        .collect()
}

fn prose_list(values: impl IntoIterator<Item = String>, conjunction: &str) -> String {
    let mut values = values.into_iter().collect::<Vec<_>>();
    let last = values.pop().assert_value();
    match values.as_slice() {
        [] => last,
        [only] => format!("{only} {conjunction} {last}"),
        _ => format!("{}, {conjunction} {last}", values.join(", ")),
    }
}
