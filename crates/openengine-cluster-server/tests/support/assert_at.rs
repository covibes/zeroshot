use serde_json::Value;

pub(super) trait AssertAt<I> {
    type Output: ?Sized;

    fn assert_at(&self, index: I) -> &Self::Output;
}

fn option_value<T>(value: Option<T>) -> T {
    assert!(value.is_some(), "expected an indexed value");
    let mut values = value.into_iter().collect::<Vec<_>>();
    values.swap_remove(0)
}

impl<T> AssertAt<usize> for [T] {
    type Output = T;

    fn assert_at(&self, index: usize) -> &Self::Output {
        option_value(self.get(index))
    }
}

impl AssertAt<usize> for Value {
    type Output = Value;

    fn assert_at(&self, index: usize) -> &Self::Output {
        option_value(self.get(index))
    }
}

impl<'a> AssertAt<&'a str> for Value {
    type Output = Value;

    fn assert_at(&self, index: &'a str) -> &Self::Output {
        option_value(self.get(index))
    }
}
