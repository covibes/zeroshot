// Bounds for the OMP RPC v2 stdio driver. Every count/size below is checked before any buffer or
// array is allocated from a peer-declared count/byteLength; see omp-rpc-driver.ts.

// Inbound RPC frames (any type — response/extension_ui_request/host_tool_call/host_uri_request/
// message frames, etc.) the driver will hold queued awaiting dispatch at once. A single stdout
// chunk can decode to an attacker-controlled number of frames before any of them is actually
// processed (dispatch is asynchronous), so this bounds that queue depth independently of each
// frame's own size caps.
export const MAX_PENDING_REQUESTS = 64;

// Total distinct request ids the driver will track ownership of across the lifetime of one task,
// bounding a slow-drip identifier-exhaustion attack from a misbehaving/compromised child.
export const MAX_LIFETIME_REQUEST_IDS = 4096;

// Total bytes of normalized OutputEvent text (text/thinking/tool_call input/tool_result content,
// serialized) the driver will accumulate for one task before failing permanently.
export const MAX_NORMALIZED_OUTPUT_BYTES = 8 * 1024 * 1024;

// Rolling tail of stderr bytes kept only for attaching to error messages; stderr is never streamed
// to output.
export const MAX_STDERR_TAIL_BYTES = 8192;

// Grace periods for the abort → SIGTERM → SIGKILL lifecycle. Not derived from an existing shared
// constant: `process-runner.ts`'s DEFAULT_TIMEOUT_KILL_GRACE_MS (100ms) is a request/response
// runner's SIGTERM→SIGKILL-only handoff, whereas the RPC driver also has to wait for an in-band
// `abort` command round-trip before the process boundary is touched at all.
export const ABORT_GRACE_MS = 2000;
export const EXIT_GRACE_MS = 2000;
