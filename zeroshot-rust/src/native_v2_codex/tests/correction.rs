use super::*;

async fn corrected_output(
    directory: &TestDirectory,
    provider: CodexProvider,
) -> (WorkerOutcome, String) {
    let capture = directory.child("capture");
    let (credential_name, credential_value) = match provider {
        CodexProvider::OpenAi => ("OPENAI_API_KEY", "fake-openai-key"),
        CodexProvider::OpenRouter => ("OPENROUTER_API_KEY", "fake-openrouter-key"),
    };
    let adapter = scripted_adapter(directory, provider);
    let model = match provider {
        CodexProvider::OpenAi => "gpt-5.6-sol",
        CodexProvider::OpenRouter => "openai/gpt-5.6-sol",
    };
    let admitted = admitted(
        binding_with_model(
            model,
            SessionScope::Execution,
            &["CAPTURE_PATH", "CORRECT_OUTPUT", credential_name],
        ),
        provider,
    )
    .await;
    let runtime = runner(&admitted, adapter);
    let mut handle = start(
        &runtime,
        &admitted,
        1,
        &[
            ("CAPTURE_PATH", capture.display().to_string()),
            ("CORRECT_OUTPUT", "true".to_owned()),
            (credential_name, credential_value.to_owned()),
        ],
    )
    .await;
    let outcome = handle.completion().await.assert_value().outcome;
    (outcome, fs::read_to_string(capture).assert_value())
}

#[tokio::test]
async fn invalid_output_is_corrected_in_the_same_codex_session() {
    let directory = TestDirectory::new("codex-correction");
    let (outcome, capture) = corrected_output(&directory, CodexProvider::OpenAi).await;

    assert!(matches!(
        outcome,
        WorkerOutcome::Verified { output, .. } if output == json!({"answer": 43})
    ));
    assert_eq!(capture.matches("arg=resume").count(), 1);
    assert_eq!(capture.matches("arg=thread-123").count(), 1);
    assert!(capture.contains("Your previous final response was rejected mechanically"));
    assert!(capture.contains("output $.answer must be a integer"));
}

#[tokio::test]
async fn openrouter_correction_scopes_configuration_to_the_resume_command() {
    let directory = TestDirectory::new("codex-openrouter-correction");
    let (outcome, capture) = corrected_output(&directory, CodexProvider::OpenRouter).await;

    assert!(matches!(
        outcome,
        WorkerOutcome::Verified { output, .. } if output == json!({"answer": 43})
    ));
    let resumed = capture.rsplit_once("---\n").assert_value().1;
    let resume_index = resumed.find("arg=resume\n").assert_value();
    let sandbox_index = resumed
        .find("arg=--sandbox\narg=workspace-write\n")
        .assert_value();
    assert!(sandbox_index < resume_index);
    for expected in [
        "arg=model_provider=\"openrouter\"\n",
        "arg=model_providers.openrouter.base_url=\"https://openrouter.ai/api/v1\"\n",
        "arg=model_providers.openrouter.env_key=\"OPENROUTER_API_KEY\"\n",
        "arg=model_providers.openrouter.wire_api=\"responses\"\n",
        "arg=approval_policy=\"never\"\n",
        "arg=sandbox_workspace_write.network_access=true\n",
        "arg=model_reasoning_effort=\"max\"\n",
        "arg=web_search=\"disabled\"\n",
    ] {
        assert!(
            resumed.find(expected).assert_value() > resume_index,
            "resume-scoped argument appeared before resume: {expected}"
        );
    }
    assert!(resumed.contains("arg=--model\narg=openai/gpt-5.6-sol\n"));
    assert!(resumed.contains("arg=thread-123\narg=-\n"));
}
