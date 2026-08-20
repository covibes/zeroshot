pub(super) fn require_error<T, E>(result: Result<T, E>) -> E {
    assert!(result.is_err(), "expected an error result");
    let mut error = result.err().into_iter();
    error.next().into_iter().collect::<Vec<_>>().swap_remove(0)
}
