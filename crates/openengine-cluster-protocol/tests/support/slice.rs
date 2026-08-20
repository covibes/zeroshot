use crate::assert_value::AssertValue;

pub(super) fn slice_at<T>(values: &[T], index: usize) -> &T {
    values
        .get(index)
        .assert_value_with("expected slice index to resolve")
}
