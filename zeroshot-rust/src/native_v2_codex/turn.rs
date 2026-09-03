use std::path::Path;

use crate::execution::process::ProcessSession;

use super::schema_file::CodexSchemaFile;

pub(super) struct CodexCommandInput<'a> {
    pub(super) resume: Option<&'a str>,
    pub(super) runtime_home: &'a Path,
    pub(super) schema_path: &'a Path,
}

pub(super) struct CodexTurnProcess {
    pub(super) process: ProcessSession,
    pub(super) _schema: CodexSchemaFile,
}

pub(super) enum CodexTurnProcessOpen {
    Ready(CodexTurnProcess),
    ProviderFailure(String),
}
