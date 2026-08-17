use crate::{assert_value::AssertValue, json_read::json_at};

pub(super) fn assert_schema_omits<T>(type_name: &str, forbidden_fields: &[&str])
where
    T: schemars::JsonSchema,
{
    let schema = serde_json::to_value(schemars::schema_for!(T)).assert_value();
    let properties = json_at(&schema, "/properties").as_object().assert_value();
    for forbidden in forbidden_fields {
        assert!(
            !properties.contains_key(*forbidden),
            "{type_name} schema unexpectedly exposes {forbidden}"
        );
    }
}
