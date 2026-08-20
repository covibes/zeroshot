use serde_json::Value;

pub(super) trait AssertAtMut<I> {
    type Output: ?Sized;

    fn assert_at_mut(&mut self, index: I) -> &mut Self::Output;
}

fn required_mut<T>(value: Option<&mut T>) -> &mut T {
    assert!(value.is_some(), "expected a mutable indexed value");
    let mut values = value.into_iter().collect::<Vec<_>>();
    values.swap_remove(0)
}

impl<T> AssertAtMut<usize> for [T] {
    type Output = T;

    fn assert_at_mut(&mut self, index: usize) -> &mut Self::Output {
        required_mut(self.get_mut(index))
    }
}

impl AssertAtMut<usize> for Value {
    type Output = Value;

    fn assert_at_mut(&mut self, index: usize) -> &mut Self::Output {
        required_mut(self.get_mut(index))
    }
}

impl<'a> AssertAtMut<&'a str> for Value {
    type Output = Value;

    fn assert_at_mut(&mut self, index: &'a str) -> &mut Self::Output {
        required_mut(self.get_mut(index))
    }
}
