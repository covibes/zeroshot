use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::BufReader;
use std::path::{Path, PathBuf};

use fs2::FileExt;
use openengine_cluster_protocol::{
    RunProfile, RunProfileDefaultRequest, RunProfileDefaultResult, RunProfileDeleteResult,
    RunProfileListRequest, RunProfileListResult, RunProfileMutationResult, RunProfileName,
    RunProfileScope, RunProfileSelector, RunProfileSetRequest, RunProfileSummary,
};
use serde::{Deserialize, Serialize};

use super::support::{CommitPaths, cleanup_temporary, write_and_commit};
use super::{NativeV2CliError, absolute_user_path, nonempty_environment};

const PROFILES_FILE: &str = "profiles.json";
const PROFILES_LOCK_FILE: &str = "profiles.lock";

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredProfiles {
    #[serde(default)]
    profiles: BTreeMap<RunProfileName, StoredProfile>,
    #[serde(default)]
    default: Option<RunProfileName>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredProfile {
    id: String,
    graph: openengine_cluster_protocol::GraphSpec,
    runtime: openengine_cluster_protocol::RuntimePlan,
}

#[derive(Clone)]
pub(crate) struct LocalRunProfileStore {
    root: PathBuf,
}

impl LocalRunProfileStore {
    pub(crate) fn production() -> Result<Self, NativeV2CliError> {
        Ok(Self {
            root: default_config_root()?,
        })
    }

    #[cfg(test)]
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub(crate) fn list(
        &self,
        request: RunProfileListRequest,
    ) -> Result<RunProfileListResult, NativeV2CliError> {
        require_local_scope(request.scope)?;
        let lock = self.lock()?;
        FileExt::lock_shared(&lock).map_err(local_io)?;
        let stored = self.read()?;
        Ok(RunProfileListResult {
            profiles: stored
                .profiles
                .iter()
                .map(|(name, profile)| RunProfileSummary {
                    id: profile.id.clone(),
                    is_default: stored.default.as_ref() == Some(name),
                    name: name.clone(),
                    scope: RunProfileScope::User,
                })
                .collect(),
        })
    }

    pub(crate) fn show(
        &self,
        selector: RunProfileSelector,
    ) -> Result<RunProfile, NativeV2CliError> {
        require_local_scope(selector.scope)?;
        let lock = self.lock()?;
        FileExt::lock_shared(&lock).map_err(local_io)?;
        let stored = self.read()?;
        profile(&stored, &selector.name).ok_or_else(|| {
            NativeV2CliError::Local(format!("profile {} was not found", selector.name))
        })
    }

    pub(crate) fn set(
        &self,
        request: RunProfileSetRequest,
    ) -> Result<RunProfileMutationResult, NativeV2CliError> {
        require_local_scope(request.scope)?;
        let lock = self.lock()?;
        lock.lock_exclusive().map_err(local_io)?;
        let mut stored = self.read()?;
        let id = stored
            .profiles
            .get(&request.name)
            .map(|profile| profile.id.clone())
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        stored.profiles.insert(
            request.name.clone(),
            StoredProfile {
                id,
                graph: request.graph,
                runtime: request.runtime,
            },
        );
        if request.set_default {
            stored.default = Some(request.name.clone());
        }
        self.write(&stored)?;
        Ok(RunProfileMutationResult {
            profile: profile(&stored, &request.name)
                .ok_or_else(|| local_message("stored profile disappeared"))?,
        })
    }

    pub(crate) fn delete(
        &self,
        selector: RunProfileSelector,
    ) -> Result<RunProfileDeleteResult, NativeV2CliError> {
        require_local_scope(selector.scope)?;
        let lock = self.lock()?;
        lock.lock_exclusive().map_err(local_io)?;
        let mut stored = self.read()?;
        let deleted = stored.profiles.remove(&selector.name).is_some();
        if stored.default.as_ref() == Some(&selector.name) {
            stored.default = None;
        }
        if deleted {
            self.write(&stored)?;
        }
        Ok(RunProfileDeleteResult { deleted })
    }

    pub(crate) fn set_default(
        &self,
        request: RunProfileDefaultRequest,
    ) -> Result<RunProfileDefaultResult, NativeV2CliError> {
        require_local_scope(request.scope)?;
        let lock = self.lock()?;
        lock.lock_exclusive().map_err(local_io)?;
        let mut stored = self.read()?;
        if let Some(name) = &request.name {
            if !stored.profiles.contains_key(name) {
                return Err(NativeV2CliError::Local(format!(
                    "profile {name} was not found"
                )));
            }
        }
        stored.default = request.name.clone();
        self.write(&stored)?;
        Ok(RunProfileDefaultResult {
            scope: RunProfileScope::User,
            name: request.name,
        })
    }

    fn lock(&self) -> Result<File, NativeV2CliError> {
        std::fs::create_dir_all(&self.root).map_err(local_io)?;
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join(PROFILES_LOCK_FILE))
            .map_err(local_io)
    }

    fn read(&self) -> Result<StoredProfiles, NativeV2CliError> {
        let path = self.root.join(PROFILES_FILE);
        match File::open(path) {
            Ok(file) => serde_json::from_reader(BufReader::new(file))
                .map_err(|_| local_message("local profile store is malformed")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(StoredProfiles::default())
            }
            Err(error) => Err(local_io(error)),
        }
    }

    fn write(&self, stored: &StoredProfiles) -> Result<(), NativeV2CliError> {
        let temporary = temporary_path(&self.root);
        let mut encoded = serde_json::to_vec(stored)
            .map_err(|_| local_message("local profile store could not be encoded"))?;
        encoded.push(b'\n');
        let result = (|| {
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .truncate(false)
                .open(&temporary)
                .map_err(local_io)?;
            let destination = self.root.join(PROFILES_FILE);
            write_and_commit(
                file,
                &encoded,
                CommitPaths {
                    temporary: &temporary,
                    destination: &destination,
                    parent: &self.root,
                },
            )
        })();
        cleanup_temporary(result, &temporary)
    }
}

fn profile(stored: &StoredProfiles, name: &RunProfileName) -> Option<RunProfile> {
    let value = stored.profiles.get(name)?;
    Some(RunProfile {
        id: value.id.clone(),
        name: name.clone(),
        scope: RunProfileScope::User,
        graph: value.graph.clone(),
        runtime: value.runtime.clone(),
        is_default: stored.default.as_ref() == Some(name),
    })
}

fn require_local_scope(scope: RunProfileScope) -> Result<(), NativeV2CliError> {
    if scope == RunProfileScope::User {
        Ok(())
    } else {
        Err(local_message(
            "organization-scoped profiles require a hosted target",
        ))
    }
}

fn default_config_root() -> Result<PathBuf, NativeV2CliError> {
    if let Some(path) = nonempty_environment("ZEROSHOT_RUST_CONFIG_DIR") {
        return absolute_user_path(path, "profile configuration path must be absolute");
    }
    if let Some(path) = nonempty_environment("XDG_CONFIG_HOME") {
        return absolute_user_path(
            PathBuf::from(path).join("zeroshot-rust"),
            "profile configuration path must be absolute",
        );
    }
    let home = nonempty_environment("HOME")
        .ok_or_else(|| local_message("HOME and XDG_CONFIG_HOME are unavailable"))?;
    absolute_user_path(
        PathBuf::from(home).join(".config").join("zeroshot-rust"),
        "profile configuration path must be absolute",
    )
}

fn temporary_path(root: &Path) -> PathBuf {
    root.join(format!("profiles.{}.tmp", uuid::Uuid::now_v7()))
}

fn local_io(error: std::io::Error) -> NativeV2CliError {
    NativeV2CliError::Local(error.to_string())
}

fn local_message(message: impl Into<String>) -> NativeV2CliError {
    NativeV2CliError::Local(message.into())
}

#[cfg(test)]
mod tests {
    use openengine_cluster_testkit::admission::graph_fixture;
    use openengine_cluster_testkit::assertions::AssertValue;
    use serde_json::json;

    use super::*;

    #[test]
    fn stable_identity_and_default_survive_profile_edits() {
        let root = std::env::temp_dir().join(format!("zeroshot-profiles-{}", uuid::Uuid::now_v7()));
        let store = LocalRunProfileStore::new(root.clone());
        let request = RunProfileSetRequest {
            name: RunProfileName::new("default").assert_value(),
            scope: RunProfileScope::User,
            graph: graph_fixture("worker", json!({"kind": "null"})),
            runtime: serde_json::from_value(json!({
                "harness": "codex",
                "provider": "openai",
                "size": "small",
                "nodes": {"worker": {"kind": "agent", "model": "gpt-5.6-sol"}}
            }))
            .assert_value(),
            set_default: true,
        };
        let first = store.set(request).assert_value().profile;
        let shown = store
            .show(RunProfileSelector {
                scope: RunProfileScope::User,
                name: first.name.clone(),
            })
            .assert_value();
        assert_eq!(shown.id, first.id);
        assert!(shown.is_default);
        let _ = std::fs::remove_dir_all(root);
    }
}
