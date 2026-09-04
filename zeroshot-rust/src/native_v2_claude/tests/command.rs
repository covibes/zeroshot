use super::*;

#[tokio::test]
async fn scripted_anthropic_and_openrouter_commands_are_exact_and_ambient_free() {
    for provider in [ClaudeProvider::Anthropic, ClaudeProvider::OpenRouter] {
        let workspace = TestDirectory::new("claude-command");
        workspace.write("fake-claude.sh", SUCCESS_SCRIPT);
        let (provider_name, provider_value) = match provider {
            ClaudeProvider::Anthropic => (ANTHROPIC_KEY, "anthropic-fake"),
            ClaudeProvider::OpenRouter => (OPENROUTER_KEY, "openrouter-fake"),
        };
        let model = match provider {
            ClaudeProvider::Anthropic => "claude-sonnet-5",
            ClaudeProvider::OpenRouter => "anthropic/provider-owned-model",
        };
        let binding = agent_binding(
            model,
            Some(ReasoningEffort::Max),
            SessionScope::Execution,
            &[provider_name, "TEST_SECRET"],
        );
        let runner = runner(&workspace, provider, binding.clone(), false).await;
        let mut handle = runner
            .start(request(
                binding,
                1,
                &[
                    (provider_name, provider_value),
                    ("TEST_SECRET", "sentinel-secret"),
                ],
            ))
            .await
            .assert_value();
        let mut attach = handle.take_initial_output().assert_value();
        let (live, completion) = tokio::join!(attach.recv_output(), handle.completion());
        assert_eq!(live.assert_value().text, "visible [REDACTED]");
        assert_eq!(
            completion.assert_value().outcome,
            WorkerOutcome::Verified {
                output: json!("done"),
                artifacts: Vec::new(),
            }
        );
        assert_token_usage(attach.recv_usage().await.assert_value(), [11, 4, 6, 2]);
        assert_eq!(attach.recv().await, Err(AttachReceiveError::Closed));
        let arguments = workspace.read("initial.args");
        let expected_prefix = format!(
            concat!(
                "--print\n--input-format\ntext\n--output-format\nstream-json\n",
                "--verbose\n--include-partial-messages\n--model\n{}\n--json-schema\n",
            ),
            model
        );
        assert!(arguments.starts_with(&expected_prefix));
        let schema = arguments
            .lines()
            .skip_while(|line| *line != "--json-schema")
            .nth(1)
            .and_then(|line| serde_json::from_str::<Value>(line).ok())
            .assert_value();
        assert_eq!(
            schema.pointer("/properties/response").assert_value(),
            &json!({"type":"string"})
        );
        assert!(arguments.contains("--effort\nmax\n--dangerously-skip-permissions\n"));
        assert!(!arguments.contains("--setting-sources"));
        assert!(!arguments.contains("perform the node task"));
        let prompt = workspace.read("initial.prompt");
        assert!(prompt.contains("Authored instructions:\nExercise the Claude adapter."));
        assert!(prompt.contains("Input JSON:\n\"perform the node task\""));
        assert!(prompt.contains("Runtime-owned response contract:\n{\"kind\":\"worker\""));
        assert_eq!(workspace.read("ambient.txt").trim(), "unset");
        assert_provider_environment(&workspace, provider, provider_value);
    }
}
