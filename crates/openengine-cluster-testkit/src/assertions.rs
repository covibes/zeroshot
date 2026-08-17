//! Small assertion helpers for fixture and integration-test code.

pub trait AssertValue<T> {
    fn assert_value(self) -> T;
    fn assert_value_with(self, context: &str) -> T;
}

impl<T, E> AssertValue<T> for Result<T, E> {
    fn assert_value(self) -> T {
        self.assert_value_with("expected a successful result")
    }

    fn assert_value_with(self, context: &str) -> T {
        let mut values = self.into_iter().collect::<Vec<_>>();
        assert_eq!(values.len(), 1, "{context}");
        values.swap_remove(0)
    }
}

impl<T> AssertValue<T> for Option<T> {
    fn assert_value(self) -> T {
        self.assert_value_with("expected a present value")
    }

    fn assert_value_with(self, context: &str) -> T {
        let mut values = self.into_iter().collect::<Vec<_>>();
        assert_eq!(values.len(), 1, "{context}");
        values.swap_remove(0)
    }
}

pub trait AssertError<E> {
    fn assert_error(self) -> E;
    fn assert_error_with(self, context: &str) -> E;
}

impl<T, E> AssertError<E> for Result<T, E> {
    fn assert_error(self) -> E {
        self.assert_error_with("expected an error result")
    }

    fn assert_error_with(self, context: &str) -> E {
        let mut errors = self.err().into_iter().collect::<Vec<_>>();
        assert_eq!(errors.len(), 1, "{context}");
        errors.swap_remove(0)
    }
}

pub trait AssertAt<T> {
    fn assert_at(&self, index: usize) -> &T;
    fn assert_at_mut(&mut self, index: usize) -> &mut T;
}

impl<T> AssertAt<T> for [T] {
    fn assert_at(&self, index: usize) -> &T {
        self.get(index).assert_value_with("expected slice index")
    }

    fn assert_at_mut(&mut self, index: usize) -> &mut T {
        self.get_mut(index)
            .assert_value_with("expected mutable slice index")
    }
}

pub trait AssertSlice<T> {
    fn assert_slice(&self, range: std::ops::Range<usize>) -> &[T];
    fn assert_slice_from(&self, start: usize) -> &[T];
    fn assert_slice_to(&self, end: usize) -> &[T];
}

impl<T> AssertSlice<T> for [T] {
    fn assert_slice(&self, range: std::ops::Range<usize>) -> &[T] {
        self.get(range).assert_value_with("expected slice range")
    }

    fn assert_slice_from(&self, start: usize) -> &[T] {
        self.get(start..)
            .assert_value_with("expected trailing slice range")
    }

    fn assert_slice_to(&self, end: usize) -> &[T] {
        self.get(..end)
            .assert_value_with("expected leading slice range")
    }
}

pub trait JsonAt {
    fn assert_key(&self, key: &str) -> &serde_json::Value;
    fn assert_key_mut(&mut self, key: &str) -> &mut serde_json::Value;
}

impl JsonAt for serde_json::Value {
    fn assert_key(&self, key: &str) -> &serde_json::Value {
        self.get(key)
            .assert_value_with("expected JSON object field")
    }

    fn assert_key_mut(&mut self, key: &str) -> &mut serde_json::Value {
        self.get_mut(key)
            .assert_value_with("expected mutable JSON object field")
    }
}
