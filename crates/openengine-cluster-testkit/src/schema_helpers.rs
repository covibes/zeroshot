use crate::fixture::*;

use serde_json::Value;

pub(crate) fn merge_schema(root: &mut Value, name: &str, mut component: Value) {
    if let Some(definitions) = component.get_mut("$defs").and_then(Value::as_object_mut) {
        let definitions = std::mem::take(definitions);
        root.assert_key_mut("$defs")
            .as_object_mut()
            .assert_value_with("root schema has definitions")
            .extend(definitions);
    }
    component
        .as_object_mut()
        .assert_value_with("schema root is an object")
        .remove("$schema");
    component
        .as_object_mut()
        .assert_value_with("schema root is an object")
        .remove("$defs");
    root.assert_key_mut("$defs")
        .as_object_mut()
        .assert_value_with("root schema definitions must be an object")
        .insert(name.to_owned(), component);
}
