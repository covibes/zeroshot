use zeroshot_engine::cluster_ledger::mutations::AdmissionRequest;
use zeroshot_engine::cluster_ledger::record::CanonicalDigest;

pub fn admission_request(
    graph: Vec<u8>,
    input: Vec<u8>,
    compiled_ir: Vec<u8>,
    absolute_deadline_ms: u64,
) -> AdmissionRequest {
    AdmissionRequest {
        graph_digest: CanonicalDigest::of(&graph),
        input_digest: CanonicalDigest::of(&input),
        policy_digest: CanonicalDigest::of(b"policy"),
        catalog_digest: CanonicalDigest::of(b"catalog"),
        profile_digest: CanonicalDigest::of(b"profile"),
        absolute_deadline_ms,
        verified_input: input,
        canonical_graph: graph,
        canonical_compiled_ir: compiled_ir,
    }
}
