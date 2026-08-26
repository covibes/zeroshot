use std::path::{Path, PathBuf};

use serde_json::Value;
use uuid::Uuid;

use crate::execution::process::write_new_file;
use crate::native_v2_runner::NodeRunnerError;

pub(super) struct CodexSchemaFile {
    path: PathBuf,
}

impl CodexSchemaFile {
    pub(super) fn create(runtime_home: &Path, schema: &Value) -> Result<Self, NodeRunnerError> {
        let path = runtime_home.join(format!("response-schema-{}.json", Uuid::now_v7()));
        let bytes = serde_json::to_vec(schema).map_err(|_| NodeRunnerError::Driver)?;
        // Hosted children have a distinct uid. The containing runtime home is mode 0700,
        // so making this non-secret contract world-readable only exposes it to that child.
        write_new_file(&path, &bytes, 0o444).map_err(|_| NodeRunnerError::Driver)?;
        Ok(Self { path })
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for CodexSchemaFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use openengine_cluster_testkit::assertions::AssertValue;
    use serde_json::json;

    use super::CodexSchemaFile;
    use crate::native_v2_candidate::test_support::TestDirectory;

    #[test]
    fn schema_file_is_readable_during_the_turn_and_removed_afterward() {
        let runtime = TestDirectory::new("codex-schema-file");
        let path = {
            let schema =
                CodexSchemaFile::create(runtime.path(), &json!({"type":"null"})).assert_value();
            let path = schema.path().to_owned();
            assert_eq!(std::fs::read(&path).assert_value(), br#"{"type":"null"}"#);
            path
        };
        assert!(!path.exists());
    }
}
