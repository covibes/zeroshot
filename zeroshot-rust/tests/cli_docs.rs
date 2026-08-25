#[path = "../examples/cli_docs/mod.rs"]
mod cli_docs;

use openengine_cluster_testkit::assertions::AssertValue;

#[test]
fn generated_cli_reference_is_current() {
    let stale = cli_docs::stale(&cli_docs::generate()).assert_value();
    assert!(
        stale.is_empty(),
        "generated CLI reference is stale: {}; run `cargo run -p zeroshot-rust --example generate_cli_docs -- --write`",
        stale
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
    assert!(
        cli_docs::write(&cli_docs::generate())
            .assert_value()
            .is_empty(),
        "writing a current CLI reference should be a no-op"
    );
}
