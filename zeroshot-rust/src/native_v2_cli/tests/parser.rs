use super::*;

#[test]
fn parser_is_the_agreed_lean_hosted_surface() {
    let run = parse_native_v2_args(args(&[
        "run",
        "--target",
        "prod",
        "--title",
        "Repair checkout",
        "--graph",
        "graph.json",
        "--input",
        "input.json",
        "--runtime-config",
        "runtime.json",
        "-d",
        "--submission-key",
        "retry-1",
    ]))
    .assert_value();
    let run = run_command(run);
    assert_eq!(run.target.as_deref(), Some("prod"));
    assert_eq!(run.title.as_str(), "Repair checkout");
    assert_eq!(run.graph, RunGraph::File(PathBuf::from("graph.json")));
    assert_eq!(run.runtime_config, PathBuf::from("runtime.json"));
    assert!(run.detach);
    assert_eq!(run.submission_key.assert_value().as_str(), "retry-1");

    for unsupported in ["--provider", "--model", "--effort", "--session", "--env"] {
        let error = parse_native_v2_args(args(&[
            "run",
            "--target",
            "prod",
            "--title",
            "Repair checkout",
            "--graph",
            "g.json",
            "--input",
            "i.json",
            "--runtime-config",
            "runtime.json",
            unsupported,
            "value",
        ]))
        .assert_error();
        assert!(matches!(error, NativeV2CliError::Usage(_)));
    }
}

#[test]
fn parser_exposes_the_two_builtin_templates_and_closed_delivery_choice() {
    assert_eq!(
        parse_native_v2_args(args(&["template", "list"])).assert_value(),
        NativeV2CliCommand::TemplateList
    );
    assert_eq!(
        parse_native_v2_args(args(&["template", "show", "software-change", "--ship"]))
            .assert_value(),
        NativeV2CliCommand::TemplateShow {
            template: BuiltinGraphTemplate::SoftwareChange,
            delivery: TemplateDelivery::Merge,
        }
    );

    let run = parse_native_v2_args(args(&[
        "run",
        "--title",
        "Repair checkout",
        "--template",
        "software-change",
        "--pr",
        "--input",
        "input.json",
        "--runtime-config",
        "runtime.json",
    ]))
    .assert_value();
    let run = run_command(run);
    assert_eq!(
        run.graph,
        RunGraph::Template {
            template: BuiltinGraphTemplate::SoftwareChange,
            delivery: TemplateDelivery::PullRequest,
        }
    );
}

fn run_command(command: NativeV2CliCommand) -> RunCommand {
    match command {
        NativeV2CliCommand::Run(run) => Some(run),
        _ => None,
    }
    .assert_value_with("run command")
}

#[test]
fn parser_rejects_ambiguous_graph_and_delivery_materialization() {
    let common = [
        "run",
        "--title",
        "Repair checkout",
        "--input",
        "input.json",
        "--runtime-config",
        "runtime.json",
    ];
    for suffix in [
        &["--graph", "graph.json", "--template", "single-worker"][..],
        &["--graph", "graph.json", "--ship"][..],
        &["--template", "single-worker", "--pr"][..],
        &["--template", "software-change", "--pr", "--ship"][..],
    ] {
        let argv = common
            .into_iter()
            .chain(suffix.iter().copied())
            .collect::<Vec<_>>();
        assert!(
            parse_native_v2_args(args(&argv)).is_err(),
            "accepted {argv:?}"
        );
    }
    assert!(parse_native_v2_args(args(&common)).is_err());
}

#[test]
fn parser_keeps_capsules_private_and_attach_read_only() {
    let attach = parse_native_v2_args(args(&["attach", "run-7", "exec-2", "--target", "prod"]))
        .assert_value();
    assert!(matches!(attach, NativeV2CliCommand::Attach { .. }));
    assert!(parse_native_v2_args(args(&["capsule", "create"])).is_err());
    assert!(
        parse_native_v2_args(args(&[
            "attach", "run-7", "exec-2", "--target", "prod", "--input", "text",
        ]))
        .is_err()
    );
}

#[test]
fn parser_exposes_named_target_setup_without_runtime_overrides() {
    let command = parse_native_v2_args(args(&[
        "target",
        "setup",
        "prod",
        "--repository",
        "open/engine",
        "--base",
        "main",
        "--target-branch",
        "release",
    ]))
    .assert_value();
    let setup = match command {
        NativeV2CliCommand::TargetSetup(setup) => Some(setup),
        _ => None,
    };
    let setup = setup.assert_value_with("setup command");
    assert_eq!(setup.repository, "open/engine");
    assert_eq!(setup.base.as_deref(), Some("main"));
    assert_eq!(setup.target_branch.as_deref(), Some("release"));
}

#[tokio::test]
async fn named_target_commands_delegate_without_interpreting_runtime_configuration() {
    let backend = FakeBackend::default();
    for argv in [
        args(&["target", "add", "prod", "--url", "https://target.example"]),
        args(&["target", "login", "prod"]),
        args(&["target", "setup", "prod", "--repository", "open/engine"]),
    ] {
        let command = parse_native_v2_args(argv).assert_value();
        execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut Vec::new())
            .await
            .assert_value();
    }
    assert_eq!(
        backend.calls(),
        [
            Call::TargetAdd {
                name: "prod".to_owned(),
                url: "https://target.example".to_owned(),
            },
            Call::TargetLogin {
                name: "prod".to_owned(),
            },
            Call::TargetSetup {
                name: "prod".to_owned(),
                repository: "open/engine".to_owned(),
                base: None,
                target_branch: None,
            },
        ]
    );
}

#[tokio::test]
async fn invalid_graph_and_input_fail_before_target_contact() {
    let backend = FakeBackend::default();
    let invalid_graph = FixtureFiles::new(json!({"not":"a graph"}), json!({"task":"ok"}));
    let command = parse_native_v2_args(run_args(
        &invalid_graph.graph,
        &invalid_graph.input,
        &invalid_graph.runtime,
        &["-d"],
    ))
    .assert_value();
    let error = execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut Vec::new())
        .await
        .assert_error();
    assert!(matches!(
        error,
        NativeV2CliError::Json { kind: "graph", .. }
    ));
    assert!(backend.calls().is_empty());

    let invalid_input = FixtureFiles::new(graph(), json!({"task":7}));
    let command = parse_native_v2_args(run_args(
        &invalid_input.graph,
        &invalid_input.input,
        &invalid_input.runtime,
        &["-d"],
    ))
    .assert_value();
    let error = execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut Vec::new())
        .await
        .assert_error();
    assert!(matches!(error, NativeV2CliError::InitialInput(_)));
    assert!(backend.calls().is_empty());
}

#[tokio::test]
async fn unsupported_graph_profile_fails_before_target_contact() {
    let mut unsupported = graph();
    *unsupported.get_mut("profile").assert_value() = json!("openengine.graph.single-worker/v1");
    let files = FixtureFiles::new(unsupported, json!({"task":"no legacy profile"}));
    let command = parse_native_v2_args(run_args(
        &files.graph,
        &files.input,
        &files.runtime,
        &["-d"],
    ))
    .assert_value();
    let backend = FakeBackend::default();
    let error = execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut Vec::new())
        .await
        .assert_error();
    assert!(matches!(error, NativeV2CliError::Usage(_)));
    assert!(backend.calls().is_empty());
}

use openengine_cluster_testkit::assertions::{AssertValue, AssertError};
