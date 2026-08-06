// Shared sentinel markers for proving that raw RPC control/system/message payloads never leak
// into normalized output (AC8): fake-omp-rpc.js injects each of these into a raw protocol field
// that the normalizer never reads, and tests assert none of them ever appear in log/attach/
// ledger output even though the associated normalized text/tool/result events do appear.
module.exports = {
  SENTINEL_SYSTEM: 'ZS_SENTINEL_SYSTEM_MARKER_9f13c2',
  SENTINEL_MESSAGE: 'ZS_SENTINEL_MESSAGE_MARKER_7ae04d',
  SENTINEL_CONTROL: 'ZS_SENTINEL_CONTROL_MARKER_5b8e91',
};
