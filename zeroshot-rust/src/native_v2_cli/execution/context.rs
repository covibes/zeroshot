use std::ffi::OsString;

pub(crate) struct CliExecutionContext<'a, B> {
    pub(super) backend: &'a B,
    pub(super) environment: &'a dyn Fn(&str) -> Option<OsString>,
}

impl<'a, B> CliExecutionContext<'a, B> {
    pub(crate) const fn new(
        backend: &'a B,
        environment: &'a dyn Fn(&str) -> Option<OsString>,
    ) -> Self {
        Self {
            backend,
            environment,
        }
    }
}
