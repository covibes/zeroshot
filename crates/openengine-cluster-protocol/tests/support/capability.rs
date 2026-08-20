use crate::{assert_value::AssertValue, json_insert::json_insert};

pub(super) fn assert_boolean_capability_schema<T>(field: &str)
where
    T: schemars::JsonSchema,
{
    let schema = serde_json::to_value(schemars::schema_for!(T)).assert_value();
    let validator = jsonschema::validator_for(&schema).assert_value();
    let mut enabled = serde_json::json!({ "graphProfiles": [] });
    json_insert(&mut enabled, "", field, serde_json::json!(true));
    assert!(validator.is_valid(&enabled));
    let mut disabled = serde_json::json!({ "graphProfiles": [] });
    json_insert(&mut disabled, "", field, serde_json::json!(false));
    assert!(validator.is_valid(&disabled));
    assert!(validator.is_valid(&serde_json::json!({ "graphProfiles": [] })));
}
