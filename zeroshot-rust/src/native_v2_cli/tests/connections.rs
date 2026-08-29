use super::*;

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
