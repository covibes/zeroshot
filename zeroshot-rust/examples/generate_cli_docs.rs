#[path = "cli_docs/mod.rs"]
mod cli_docs;

use std::env;
use std::process::ExitCode;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("generate_cli_docs: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mode = match env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [mode] if mode == "--write" => Mode::Write,
        [mode] if mode == "--check" => Mode::Check,
        _ => return Err("expected exactly one of --write or --check".to_owned()),
    };
    let documents = cli_docs::generate();
    match mode {
        Mode::Write => write(&documents),
        Mode::Check => check(&documents),
    }
}

fn write(documents: &cli_docs::Documents) -> Result<(), String> {
    let changed = cli_docs::write(documents).map_err(|error| error.to_string())?;
    if changed.is_empty() {
        println!("CLI reference is up to date");
    }
    for path in changed {
        println!("wrote {}", path.display());
    }
    Ok(())
}

fn check(documents: &cli_docs::Documents) -> Result<(), String> {
    let stale = cli_docs::stale(documents).map_err(|error| error.to_string())?;
    if stale.is_empty() {
        println!("CLI reference is up to date");
        return Ok(());
    }
    let paths = stale
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "generated CLI reference is stale: {paths}; rerun with --write"
    ))
}

enum Mode {
    Write,
    Check,
}
