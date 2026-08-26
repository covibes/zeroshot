use super::*;

#[test]
fn supported_models_and_efforts_match_the_admission_catalog() {
    assert!(validate_model_effort("claude-haiku-4-5", None).is_ok());
    assert!(validate_model_effort("claude-haiku-4-5", Some(ReasoningEffort::Max)).is_err());
    for model in ["claude-sonnet-5", "claude-opus-5", "claude-fable-5"] {
        for effort in [
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max,
        ] {
            assert!(validate_model_effort(model, Some(effort)).is_ok());
        }
        assert!(validate_model_effort(model, None).is_err());
    }
}
