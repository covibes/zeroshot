use super::*;

#[test]
fn parser_exposes_static_help_and_version_commands() {
    assert_eq!(
        parse_native_v2_args(args(&["--version"])).assert_value(),
        NativeV2CliCommand::Version
    );
    assert_eq!(
        parse_native_v2_args(args(&["version"])).assert_value(),
        NativeV2CliCommand::Version
    );
    assert!(parse_native_v2_args(args(&["--version", "extra"])).is_err());
}

#[test]
fn connection_commands_keep_secret_values_out_of_arguments() {
    let set = parse_native_v2_args(args(&[
        "connection",
        "set",
        "github",
        "--target",
        "prod",
        "--scope",
        "org",
        "--field",
        "GH_TOKEN",
    ]))
    .assert_value();
    let set = match set {
        NativeV2CliCommand::ConnectionSet(command) => Some(command),
        _ => None,
    }
    .assert_value_with("connection set command");
    assert_eq!(set.key.as_str(), "github");
    assert_eq!(set.route.target.as_deref(), Some("prod"));
    assert_eq!(set.route.scope, ConnectionScope::Org);
    let expected_fields = [EnvironmentVariableName::new("GH_TOKEN").assert_value()];
    assert!(matches!(set.input, ConnectionInput::Prompt(fields) if fields == expected_fields));

    assert!(
        parse_native_v2_args(args(&[
            "connection",
            "set",
            "github",
            "--field",
            "GH_TOKEN",
            "--json-stdin"
        ]))
        .is_err()
    );
    assert!(
        parse_native_v2_args(args(&[
            "connection",
            "set",
            "github",
            "--field",
            "GH_TOKEN",
            "--field",
            "GH_TOKEN",
        ]))
        .is_err()
    );
    assert!(
        parse_native_v2_args(args(&[
            "connection",
            "set",
            "github",
            "--field",
            "GH_TOKEN=value",
        ]))
        .is_err()
    );
}

#[test]
fn durable_observation_accepts_native_resume_and_execution_filters() {
    let watch = parse_native_v2_args(args(&[
        "watch", "run-7", "--target", "prod", "--after", "cloud:12",
    ]))
    .assert_value();
    let watch = match watch {
        NativeV2CliCommand::Watch(command) => Some(command),
        _ => None,
    }
    .assert_value_with("watch command");
    assert_eq!(watch.run.target.as_deref(), Some("prod"));
    assert_eq!(watch.run.run_id.as_str(), "run-7");
    assert_eq!(watch.after.as_ref().map(Cursor::as_str), Some("cloud:12"));

    let logs = parse_native_v2_args(args(&[
        "logs",
        "run-7",
        "--after",
        "cloud:13",
        "--execution",
        "opaque-worker-2",
    ]))
    .assert_value();
    let logs = match logs {
        NativeV2CliCommand::Logs(command) => Some(command),
        _ => None,
    }
    .assert_value_with("logs command");
    assert_eq!(logs.after.as_ref().map(Cursor::as_str), Some("cloud:13"));
    assert_eq!(
        logs.execution.as_ref().map(ExecutionRef::as_str),
        Some("opaque-worker-2")
    );
}

#[test]
fn explicit_template_delivery_is_parsed_and_validated_by_rust() {
    let shown = parse_native_v2_args(args(&[
        "template",
        "show",
        "software-change",
        "--delivery",
        "merge",
    ]))
    .assert_value();
    assert!(matches!(
        shown,
        NativeV2CliCommand::TemplateShow {
            delivery: TemplateDelivery::Merge,
            ..
        }
    ));

    let error = parse_native_v2_args(args(&[
        "template",
        "show",
        "software-change",
        "--delivery",
        "future-mode",
    ]))
    .assert_error();
    assert!(error.to_string().contains("future-mode"));
}

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
        "--branch",
        "feature/source-selection",
        "-d",
        "--submission-key",
        "retry-1",
    ]))
    .assert_value();
    let run = run_command(run);
    assert_eq!(run.target.as_deref(), Some("prod"));
    assert_eq!(run.title.as_str(), "Repair checkout");
    assert_eq!(run.graph, RunGraph::File(PathBuf::from("graph.json")));
    assert_eq!(
        run.runtime,
        RunRuntime::Exact(PathBuf::from("runtime.json"))
    );
    assert!(!run.validate_only);
    assert_eq!(
        run.branch.as_ref().map(SourceBranchId::as_str),
        Some("feature/source-selection")
    );
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
fn branch_override_requires_a_named_target() {
    let error = parse_native_v2_args(args(&[
        "run",
        "--title",
        "Repair checkout",
        "--graph",
        "graph.json",
        "--input",
        "input.json",
        "--runtime-config",
        "runtime.json",
        "--branch",
        "feature",
    ]))
    .assert_error();
    assert!(
        matches!(error, NativeV2CliError::Usage(message) if message == "--branch requires --target")
    );
}

#[test]
fn branch_selectors_are_validated_before_target_contact() {
    for argv in [
        vec![
            "target",
            "setup",
            "prod",
            "--repository",
            "open/engine",
            "--branch",
            "release.lock",
        ],
        vec![
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
            "--branch",
            "release.lock",
        ],
    ] {
        assert!(parse_native_v2_args(args(&argv)).is_err());
    }
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
fn parser_exposes_named_target_default_branch() {
    let command = parse_native_v2_args(args(&[
        "target",
        "setup",
        "prod",
        "--repository",
        "open/engine",
        "--branch",
        "main",
    ]))
    .assert_value();
    let setup = match command {
        NativeV2CliCommand::TargetSetup(setup) => Some(setup),
        _ => None,
    };
    let setup = setup.assert_value_with("setup command");
    assert_eq!(setup.repository, "open/engine");
    assert_eq!(
        setup.default_branch.as_ref().map(SourceBranchId::as_str),
        Some("main")
    );
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
                direct: false,
            },
            Call::TargetLogin {
                name: "prod".to_owned(),
            },
            Call::TargetSetup {
                name: "prod".to_owned(),
                repository: "open/engine".to_owned(),
                default_branch: None,
            },
        ]
    );
}

#[tokio::test]
async fn target_serve_stops_at_the_process_execution_boundary() {
    let command = parse_native_v2_args(args(&[
        "target",
        "serve",
        "--listen",
        "127.0.0.1:8080",
        "--public-origin",
        "http://127.0.0.1:8080",
        "--storage",
        "/tmp/zeroshot-target",
    ]))
    .assert_value();
    let error = execute_native_v2_cli(
        command,
        &FakeBackend::default(),
        &mut NeverDetach,
        &mut Vec::new(),
    )
    .await
    .assert_error();
    assert!(matches!(error, NativeV2CliError::ProcessCommand));
}

#[test]
fn target_add_requires_an_explicit_direct_flag() {
    let direct = parse_native_v2_args(args(&[
        "target",
        "add",
        "vm",
        "--url",
        "http://127.0.0.1:8080",
        "--direct",
    ]))
    .assert_value();
    assert!(matches!(
        direct,
        NativeV2CliCommand::TargetAdd(TargetAdd { direct: true, .. })
    ));

    let hosted = parse_native_v2_args(args(&[
        "target",
        "add",
        "cloud",
        "--url",
        "https://target.example",
    ]))
    .assert_value();
    assert!(matches!(
        hosted,
        NativeV2CliCommand::TargetAdd(TargetAdd { direct: false, .. })
    ));
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
    let error = rejected_without_backend_contact(command, &backend).await;
    assert!(matches!(error, NativeV2CliError::Usage(_)));
}
