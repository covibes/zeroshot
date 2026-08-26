use std::ffi::OsStr;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

use super::private_file::PrivateFileTargetCredentialStore;
use super::{CredentialStorePreparation, KeyringTargetCredentialStore, TargetCredentialStore};
use crate::native_v2_target::controller_authority::contract::authority_error;
use crate::native_v2_target::TargetAuthorityError;

const CREDENTIAL_STORE_ENV: &str = "ZEROSHOT_RUST_CREDENTIAL_STORE";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Backend {
    System,
    File,
}

pub(super) struct LinuxTargetCredentialStore {
    system: Arc<dyn TargetCredentialStore>,
    file: PrivateFileTargetCredentialStore,
    forced: Option<Backend>,
    desktop_session: bool,
}

impl LinuxTargetCredentialStore {
    pub(super) fn from_environment(directory: PathBuf) -> Result<Self, TargetAuthorityError> {
        Ok(Self {
            system: Arc::new(KeyringTargetCredentialStore),
            file: PrivateFileTargetCredentialStore::new(directory),
            forced: parse_preference(std::env::var_os(CREDENTIAL_STORE_ENV).as_deref())?,
            desktop_session: has_desktop_session(),
        })
    }

    #[cfg(test)]
    pub(super) fn with_dependencies(
        directory: PathBuf,
        system: Arc<dyn TargetCredentialStore>,
        forced: Option<&str>,
        desktop_session: bool,
    ) -> Result<Self, TargetAuthorityError> {
        Ok(Self {
            system,
            file: PrivateFileTargetCredentialStore::new(directory),
            forced: parse_preference(forced.map(OsStr::new))?,
            desktop_session,
        })
    }

    async fn stored_backend(
        &self,
        target_id: &str,
    ) -> Result<Option<Backend>, TargetAuthorityError> {
        self.file
            .read_backend(target_id)
            .await?
            .map(|value| match value.as_str() {
                "system\n" => Ok(Backend::System),
                "file\n" => Ok(Backend::File),
                _ => Err(authority_error(
                    "target credential store selection is malformed",
                )),
            })
            .transpose()
    }

    async fn remember_backend(
        &self,
        target_id: &str,
        backend: Backend,
    ) -> Result<(), TargetAuthorityError> {
        let value = match backend {
            Backend::System => "system\n",
            Backend::File => "file\n",
        };
        self.file.write_backend(target_id, value).await
    }

    async fn prepare_backend(
        &self,
        backend: Backend,
        target_id: &str,
    ) -> Result<CredentialStorePreparation, TargetAuthorityError> {
        self.backend(backend).prepare_for_login(target_id).await
    }

    fn backend(&self, backend: Backend) -> &dyn TargetCredentialStore {
        match backend {
            Backend::System => self.system.as_ref(),
            Backend::File => &self.file,
        }
    }

    async fn initial_backend(&self, target_id: &str) -> Backend {
        match self.system.get(target_id).await {
            Ok(Some(_)) => Backend::System,
            Ok(None) if self.desktop_session => Backend::System,
            Ok(None) | Err(_) => Backend::File,
        }
    }

    async fn login_backend(&self, target_id: &str) -> Result<Backend, TargetAuthorityError> {
        if let Some(forced) = self.forced {
            return Ok(forced);
        }
        Ok(match self.stored_backend(target_id).await? {
            Some(stored) => stored,
            None => self.initial_backend(target_id).await,
        })
    }

    async fn prepare_with_fallback(
        &self,
        target_id: &str,
        desired: Backend,
    ) -> Result<(Backend, CredentialStorePreparation), TargetAuthorityError> {
        match self.prepare_backend(desired, target_id).await {
            Ok(preparation) => Ok((desired, preparation)),
            Err(_) if self.forced.is_none() && desired == Backend::System => self
                .prepare_backend(Backend::File, target_id)
                .await
                .map(|preparation| (Backend::File, preparation)),
            Err(error) => Err(error),
        }
    }
}

#[async_trait]
impl TargetCredentialStore for LinuxTargetCredentialStore {
    async fn prepare_for_login(
        &self,
        target_id: &str,
    ) -> Result<CredentialStorePreparation, TargetAuthorityError> {
        let desired = self.login_backend(target_id).await?;
        let (selected, preparation) = self.prepare_with_fallback(target_id, desired).await?;
        self.remember_backend(target_id, selected).await?;
        Ok(preparation)
    }

    async fn get(&self, target_id: &str) -> Result<Option<String>, TargetAuthorityError> {
        if let Some(selected) = self.forced.or(self.stored_backend(target_id).await?) {
            return self.backend(selected).get(target_id).await;
        }
        if let Ok(Some(token)) = self.system.get(target_id).await {
            self.remember_backend(target_id, Backend::System).await?;
            return Ok(Some(token));
        }
        let token = self.file.get(target_id).await?;
        if token.is_some() {
            self.remember_backend(target_id, Backend::File).await?;
        }
        Ok(token)
    }

    async fn set(&self, target_id: &str, refresh_token: &str) -> Result<(), TargetAuthorityError> {
        let selected = match self.forced.or(self.stored_backend(target_id).await?) {
            Some(selected) => selected,
            None if self.desktop_session => Backend::System,
            None => Backend::File,
        };
        self.backend(selected).set(target_id, refresh_token).await?;
        if selected == Backend::System {
            self.file.remove_credential(target_id).await?;
        }
        self.remember_backend(target_id, selected).await
    }
}

fn parse_preference(value: Option<&OsStr>) -> Result<Option<Backend>, TargetAuthorityError> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    match value.to_str() {
        Some("auto") => Ok(None),
        Some("system") => Ok(Some(Backend::System)),
        Some("file") => Ok(Some(Backend::File)),
        _ => Err(authority_error(
            "ZEROSHOT_RUST_CREDENTIAL_STORE must be auto, system, or file",
        )),
    }
}

fn has_desktop_session() -> bool {
    ["DISPLAY", "WAYLAND_DISPLAY"]
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
}
