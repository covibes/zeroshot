//! Fixed process protocol for the foreground agent's trusted greeting validator.

use std::io::{Read, Write};

use serde::Serialize;
use sha2::{Digest, Sha256};

pub const VALIDATOR_MODE: &str = "--native-validate-greeting";
pub const MAX_EXPECTED_GREETING_BYTES: usize = 4 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidationOutput<'a> {
    path: &'a str,
    sha256: String,
    status: &'a str,
}

pub fn run_greeting_validator() -> std::io::Result<()> {
    let mut expected = Vec::new();
    std::io::stdin()
        .take((MAX_EXPECTED_GREETING_BYTES + 1) as u64)
        .read_to_end(&mut expected)?;
    if expected.is_empty() || expected.len() > MAX_EXPECTED_GREETING_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid expected greeting",
        ));
    }
    let actual = std::fs::read("greeting.txt")?;
    if actual != expected {
        return Err(std::io::Error::other("greeting validation failed"));
    }
    let output = ValidationOutput {
        path: "greeting.txt",
        sha256: format!("{:x}", Sha256::digest(&actual)),
        status: "passed",
    };
    let bytes = serde_json::to_vec(&output).map_err(std::io::Error::other)?;
    std::io::stdout().write_all(&bytes)
}
