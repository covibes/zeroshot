use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Write};
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use fs2::FileExt;
use openengine_cluster_protocol::{
    ConnectionDeleteRequest, ConnectionDeleteResult, ConnectionKey, ConnectionListRequest,
    ConnectionListResult, ConnectionMutationResult, ConnectionScope, ConnectionSetRequest,
    ConnectionSummary, EnvironmentVariableName, RunConnectionValues, RuntimePlan,
    StaticConnectionValues, STATIC_CONNECTION_KIND,
};

use super::{NativeV2CliError, local_io, local_message, prepare_private_directory};
use crate::native_v2_supervisor::RunEnvironment;

const CONNECTIONS_FILE: &str = "connections.json";
const CONNECTIONS_LOCK_FILE: &str = "connections.lock";

type StoredConnections = BTreeMap<ConnectionKey, StaticConnectionValues>;

pub(super) struct LocalConnectionStore {
    root: PathBuf,
}

impl LocalConnectionStore {
    pub(super) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub(super) fn list(
        &self,
        request: ConnectionListRequest,
    ) -> Result<ConnectionListResult, NativeV2CliError> {
        require_user_scope(request.scope)?;
        let lock = self.lock()?;
        FileExt::lock_shared(&lock).map_err(local_io)?;
        let connections = self.read()?;
        Ok(ConnectionListResult {
            connections: connections
                .into_iter()
                .map(|(key, values)| summary(key, values.field_names()))
                .collect(),
        })
    }

    pub(super) fn set(
        &self,
        request: ConnectionSetRequest,
    ) -> Result<ConnectionMutationResult, NativeV2CliError> {
        require_user_scope(request.scope)?;
        let lock = self.lock()?;
        lock.lock_exclusive().map_err(local_io)?;
        let mut connections = self.read()?;
        let result = ConnectionMutationResult {
            connection: summary(request.key.clone(), request.values.field_names()),
        };
        connections.insert(request.key, request.values);
        self.write(&connections)?;
        Ok(result)
    }

    pub(super) fn delete(
        &self,
        request: ConnectionDeleteRequest,
    ) -> Result<ConnectionDeleteResult, NativeV2CliError> {
        require_user_scope(request.scope)?;
        let lock = self.lock()?;
        lock.lock_exclusive().map_err(local_io)?;
        let mut connections = self.read()?;
        let deleted = connections.remove(&request.key).is_some();
        if deleted {
            self.write(&connections)?;
        }
        Ok(ConnectionDeleteResult { deleted })
    }

    pub(super) fn resolve(
        &self,
        runtime: &RuntimePlan,
        explicit: &RunConnectionValues,
    ) -> Result<RunEnvironment, NativeV2CliError> {
        let requirements = runtime.connection_requirements();
        let lock = self.lock()?;
        FileExt::lock_shared(&lock).map_err(local_io)?;
        let stored = self.read()?;
        let mut resolved = RunConnectionValues::new();
        for (key, fields) in requirements {
            resolved.insert(
                key.clone(),
                StaticConnectionValues::new(resolve_connection(&key, &fields, explicit, &stored)?)
                    .map_err(|_| local_message("resolved connection shape is invalid"))?,
            );
        }
        RunEnvironment::exact(runtime, resolved).map_err(Into::into)
    }

    fn lock(&self) -> Result<File, NativeV2CliError> {
        prepare_private_directory(&self.root)?;
        let path = self.root.join(CONNECTIONS_LOCK_FILE);
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW);
        let file = options.open(path).map_err(local_io)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(local_io)?;
        Ok(file)
    }

    fn read(&self) -> Result<StoredConnections, NativeV2CliError> {
        let path = self.root.join(CONNECTIONS_FILE);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BTreeMap::new());
            }
            Err(error) => return Err(local_io(error)),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(local_message(
                "local connection store is not a regular file",
            ));
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(local_io)?;
        let mut options = OpenOptions::new();
        options.read(true).custom_flags(libc::O_NOFOLLOW);
        let file = options.open(&path).map_err(local_io)?;
        serde_json::from_reader(BufReader::new(file))
            .map_err(|_| local_message("local connection store is malformed"))
    }

    fn write(&self, connections: &StoredConnections) -> Result<(), NativeV2CliError> {
        let temporary = temporary_path(&self.root);
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW);
        let result = (|| {
            let file = options.open(&temporary).map_err(local_io)?;
            let mut writer = BufWriter::new(file);
            serde_json::to_writer(&mut writer, connections)
                .map_err(|_| local_message("local connection store could not be encoded"))?;
            writer.write_all(b"\n").map_err(local_io)?;
            writer.flush().map_err(local_io)?;
            writer.get_ref().sync_all().map_err(local_io)?;
            std::fs::rename(&temporary, self.root.join(CONNECTIONS_FILE)).map_err(local_io)?;
            File::open(&self.root)
                .and_then(|directory| directory.sync_all())
                .map_err(local_io)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}

fn resolve_connection(
    key: &ConnectionKey,
    fields: &BTreeSet<EnvironmentVariableName>,
    explicit: &RunConnectionValues,
    stored: &StoredConnections,
) -> Result<BTreeMap<EnvironmentVariableName, String>, NativeV2CliError> {
    let source = if let Some(values) = explicit.get(key) {
        let source = values.as_map();
        if source.len() != fields.len() || fields.iter().any(|field| !source.contains_key(field)) {
            return Err(local_message(format!(
                "explicit connection {key} does not exactly define its required fields"
            )));
        }
        source
    } else {
        stored
            .get(key)
            .map(StaticConnectionValues::as_map)
            .ok_or_else(|| local_message(format!("required connection {key} is unavailable")))?
    };
    fields
        .iter()
        .map(|field| {
            let value = source.get(field).cloned().ok_or_else(|| {
                local_message(format!(
                    "connection {key} is missing required field {field}"
                ))
            })?;
            Ok((field.clone(), value))
        })
        .collect()
}

fn temporary_path(root: &Path) -> PathBuf {
    root.join(format!("connections.{}.tmp", uuid::Uuid::now_v7()))
}

fn require_user_scope(scope: ConnectionScope) -> Result<(), NativeV2CliError> {
    if scope == ConnectionScope::User {
        Ok(())
    } else {
        Err(local_message(
            "organization-scoped connections require a hosted target",
        ))
    }
}

fn summary(key: ConnectionKey, fields: Vec<EnvironmentVariableName>) -> ConnectionSummary {
    ConnectionSummary {
        key,
        scope: ConnectionScope::User,
        kind: STATIC_CONNECTION_KIND.to_owned(),
        fields,
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use openengine_cluster_protocol::{
        CodexProvider, DeclaredConnections, DeclaredEnvironment, ModelId, NodeName,
        NodeRuntimeBinding, RunSize, SessionScope,
    };
    use openengine_cluster_testkit::assertions::{AssertError, AssertValue};

    use super::*;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            Self(
                std::env::temp_dir().join(format!("zeroshot-connections-{}", uuid::Uuid::now_v7())),
            )
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn key(value: &str) -> ConnectionKey {
        ConnectionKey::new(value).assert_value()
    }

    fn field(value: &str) -> EnvironmentVariableName {
        EnvironmentVariableName::new(value).assert_value()
    }

    fn values(entries: &[(&str, &str)]) -> StaticConnectionValues {
        StaticConnectionValues::new(
            entries
                .iter()
                .map(|(name, value)| (field(name), (*value).to_owned()))
                .collect(),
        )
        .assert_value()
    }

    fn runtime(fields: &[&str]) -> RuntimePlan {
        let environment =
            DeclaredEnvironment::new(fields.iter().map(|name| field(name))).assert_value();
        let connections = DeclaredConnections::single("provider", environment).assert_value();
        RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            size: RunSize::Small,
            nodes: BTreeMap::from([(
                NodeName::new("worker").assert_value(),
                NodeRuntimeBinding::Agent {
                    model: ModelId::new("gpt-5.6").assert_value(),
                    effort: None,
                    session_scope: SessionScope::Execution,
                    connections,
                },
            )]),
        }
    }

    #[test]
    fn static_crud_exposes_metadata_only_and_uses_private_files() {
        let root = TestRoot::new();
        let store = LocalConnectionStore::new(root.0.clone());
        let mutation = store
            .set(ConnectionSetRequest {
                key: key("provider"),
                scope: ConnectionScope::User,
                values: values(&[("OPENAI_API_KEY", "very-secret")]),
            })
            .assert_value();
        assert_eq!(mutation.connection.fields, [field("OPENAI_API_KEY")]);
        assert!(!format!("{mutation:?}").contains("very-secret"));

        let list = store
            .list(ConnectionListRequest {
                scope: ConnectionScope::User,
            })
            .assert_value();
        assert_eq!(list.connections, [mutation.connection]);
        let metadata = std::fs::metadata(root.0.join(CONNECTIONS_FILE)).assert_value();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        assert_eq!(
            std::fs::metadata(&root.0)
                .assert_value()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );

        let deleted = store
            .delete(ConnectionDeleteRequest {
                key: key("provider"),
                scope: ConnectionScope::User,
            })
            .assert_value();
        assert!(deleted.deleted);
        assert!(
            store
                .list(ConnectionListRequest {
                    scope: ConnectionScope::User
                })
                .assert_value()
                .connections
                .is_empty()
        );
    }

    #[test]
    fn resolution_selects_declared_fields_and_rejects_partial_explicit_overrides() {
        let root = TestRoot::new();
        let store = LocalConnectionStore::new(root.0.clone());
        store
            .set(ConnectionSetRequest {
                key: key("provider"),
                scope: ConnectionScope::User,
                values: values(&[
                    ("OPENAI_API_KEY", "stored-key"),
                    ("UNDECLARED", "stored-extra"),
                ]),
            })
            .assert_value();
        let single_field_runtime = runtime(&["OPENAI_API_KEY"]);
        let resolved = store
            .resolve(&single_field_runtime, &BTreeMap::new())
            .assert_value();
        assert_eq!(
            resolved.bootstrap_values(),
            BTreeMap::from([(key("provider"), values(&[("OPENAI_API_KEY", "stored-key")]),)])
        );

        let runtime = runtime(&["OPENAI_API_KEY", "OPENAI_ORG"]);
        let error = store
            .resolve(
                &runtime,
                &BTreeMap::from([(key("provider"), values(&[("OPENAI_API_KEY", "inline")]))]),
            )
            .assert_error();
        assert!(error.to_string().contains("does not exactly define"));
    }

    #[test]
    fn local_store_rejects_org_scope() {
        let root = TestRoot::new();
        let error = LocalConnectionStore::new(root.0.clone())
            .list(ConnectionListRequest {
                scope: ConnectionScope::Org,
            })
            .assert_error();
        assert!(error.to_string().contains("hosted target"));
        assert!(!root.0.exists());
    }
}
