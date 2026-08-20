use crate::assert_value::AssertValue;

pub(super) fn json_insert(
    value: &mut serde_json::Value,
    object_pointer: &str,
    key: &str,
    inserted: serde_json::Value,
) {
    let object = if object_pointer.is_empty() {
        value
    } else {
        value
            .pointer_mut(object_pointer)
            .assert_value_with("expected mutable JSON pointer to resolve")
    }
    .as_object_mut()
    .assert_value_with("expected JSON object at pointer");
    let _ = object.insert(key.to_owned(), inserted);
}
