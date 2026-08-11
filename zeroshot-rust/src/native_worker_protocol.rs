//! Private constants shared by the native coordinator and the current-binary worker mode.

use std::fs::OpenOptions;
use std::io::{Read, Write};

use openengine_cluster_protocol::{canonical_value_bytes, WorkerOutcome};

use crate::cluster_ledger::record::CanonicalDigest;

pub(crate) const WORKER_REF: &str = "native.deterministic@1";
pub const WORKER_MODE: &str = "__native-deterministic-worker";
pub(crate) const OUTPUT_VALUE: i64 = 42;

pub(crate) fn effect_marker_id(cluster: &str, run: u64, execution: u64) -> String {
    let identity = serde_json::to_vec(&(cluster, run, execution))
        .expect("native effect identity must serialize");
    let digest = CanonicalDigest::of(&identity);
    digest_hex(digest)
}

pub(crate) fn digest_hex(digest: CanonicalDigest) -> String {
    let mut value = String::with_capacity(64);
    for byte in digest.as_bytes() {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    value
}

pub(crate) fn effect_marker_name(effect_id: &str) -> String {
    format!("native-effect-{effect_id}.marker")
}

#[doc(hidden)]
pub fn run_deterministic_worker(effect_id: &str) -> std::io::Result<()> {
    let mut input = Vec::new();
    std::io::stdin().take(1024).read_to_end(&mut input)?;
    if input != b"null" {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "native deterministic worker input is invalid",
        ));
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(effect_marker_name(effect_id))?;
    writeln!(file, "{WORKER_REF} {effect_id}")?;
    file.sync_all()?;
    let outcome = WorkerOutcome::Verified {
        output: serde_json::json!({ "value": OUTPUT_VALUE }),
        artifacts: Vec::new(),
    };
    let value = serde_json::to_value(outcome).map_err(std::io::Error::other)?;
    let bytes = canonical_value_bytes(&value).map_err(std::io::Error::other)?;
    std::io::stdout().write_all(&bytes)?;
    std::io::stdout().flush()
}
