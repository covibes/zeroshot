use crate::assert_value::AssertValue;

pub(super) fn json_at_mut<'a>(
    value: &'a mut serde_json::Value,
    pointer: &str,
) -> &'a mut serde_json::Value {
    value
        .pointer_mut(pointer)
        .assert_value_with("expected mutable JSON pointer to resolve")
}
