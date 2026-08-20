use crate::assert_value::AssertValue;

pub(super) fn json_at<'a>(value: &'a serde_json::Value, pointer: &str) -> &'a serde_json::Value {
    value
        .pointer(pointer)
        .assert_value_with("expected JSON pointer to resolve")
}
