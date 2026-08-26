use super::*;

pub(super) struct CursorCallArgs<'a> {
    pub(super) kind: CursorCallKind,
    pub(super) target: Option<&'a str>,
    pub(super) run_id: &'a RunId,
    pub(super) from_cursor: Option<&'a openengine_cluster_protocol::Cursor>,
    pub(super) execution: Option<&'a openengine_cluster_protocol::ExecutionRef>,
}

pub(super) fn record_cursor_call(backend: &FakeBackend, args: CursorCallArgs<'_>) -> usize {
    let mut calls = backend.calls.lock().assert_value();
    let attempt = calls
        .iter()
        .filter(|call| {
            matches!(
                (args.kind, call),
                (CursorCallKind::Watch, Call::Watch { .. })
                    | (CursorCallKind::Logs, Call::Logs { .. })
            )
        })
        .count()
        + 1;
    let target = args.target.map(str::to_owned);
    let run_id = args.run_id.as_str().to_owned();
    let from_cursor = args.from_cursor.map(|cursor| cursor.as_str().to_owned());
    let execution = args
        .execution
        .map(|execution| execution.as_str().to_owned());
    calls.push(match args.kind {
        CursorCallKind::Watch => Call::Watch {
            target,
            run_id,
            from_cursor,
        },
        CursorCallKind::Logs => Call::Logs {
            target,
            run_id,
            from_cursor,
            execution,
        },
    });
    attempt
}
