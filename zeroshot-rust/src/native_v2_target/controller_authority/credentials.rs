use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;

use super::authority_error;
use crate::native_v2_target::registry::{create_private_directory, lock_registry, open_lock};
use crate::native_v2_target::TargetAuthorityError;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
mod private_file;
#[cfg(all(test, target_os = "linux"))]
mod tests;

#[async_trait]
pub(crate) trait TargetCredentialStore: Send + Sync {
    async fn prepare_for_login(
        &self,
        _target_id: &str,
    ) -> Result<CredentialStorePreparation, TargetAuthorityError> {
        Ok(CredentialStorePreparation::Managed)
    }

    async fn get(&self, target_id: &str) -> Result<Option<String>, TargetAuthorityError>;
    async fn set(&self, target_id: &str, refresh_token: &str) -> Result<(), TargetAuthorityError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CredentialStorePreparation {
    Managed,
    PrivateFile(PathBuf),
}

pub(super) fn production_target_credential_store(
    directory: PathBuf,
) -> Result<Arc<dyn TargetCredentialStore>, TargetAuthorityError> {
    #[cfg(target_os = "linux")]
    {
        linux::LinuxTargetCredentialStore::from_environment(directory)
            .map(|store| Arc::new(store) as Arc<dyn TargetCredentialStore>)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = directory;
        Ok(Arc::new(KeyringTargetCredentialStore))
    }
}

pub(crate) trait DeviceCodeNotifier: Send + Sync {
    fn show(&self, verification_uri: &str, user_code: &str);
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct StderrDeviceCodeNotifier;

impl DeviceCodeNotifier for StderrDeviceCodeNotifier {
    fn show(&self, verification_uri: &str, user_code: &str) {
        eprintln!(
            "\nOpen this URL to authorize:\n  {verification_uri}\n\nEnter code: {user_code}\n"
        );
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct KeyringTargetCredentialStore;

#[async_trait]
impl TargetCredentialStore for KeyringTargetCredentialStore {
    async fn prepare_for_login(
        &self,
        target_id: &str,
    ) -> Result<CredentialStorePreparation, TargetAuthorityError> {
        self.get(target_id).await?;
        Ok(CredentialStorePreparation::Managed)
    }

    async fn get(&self, target_id: &str) -> Result<Option<String>, TargetAuthorityError> {
        let service = credential_service(target_id)?;
        tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(&service, "refresh-token")
                .map_err(|_| authority_error("target credential store is unavailable"))?;
            match entry.get_password() {
                Ok(token) => Ok(Some(token)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(authority_error("target credential store read failed")),
            }
        })
        .await
        .map_err(|_| authority_error("target credential store task failed"))?
    }

    async fn set(&self, target_id: &str, refresh_token: &str) -> Result<(), TargetAuthorityError> {
        let service = credential_service(target_id)?;
        let refresh_token = refresh_token.to_owned();
        tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(&service, "refresh-token")
                .map_err(|_| authority_error("target credential store is unavailable"))?;
            entry
                .set_password(&refresh_token)
                .map_err(|_| authority_error("target credential store write failed"))
        })
        .await
        .map_err(|_| authority_error("target credential store task failed"))?
    }
}

pub(super) fn credential_service(target_id: &str) -> Result<String, TargetAuthorityError> {
    if target_id.len() != 36
        || !target_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(authority_error(
            "stored target credential identity is invalid",
        ));
    }
    Ok(format!("zeroshot-target-{target_id}"))
}

pub(super) struct TargetRefreshGuard(File);

impl Drop for TargetRefreshGuard {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

pub(super) fn open_refresh_lock(
    directory: &Path,
    path: &Path,
) -> Result<TargetRefreshGuard, TargetAuthorityError> {
    create_private_directory(directory)
        .map_err(|_| authority_error("target refresh lock directory is unavailable"))?;
    let lock =
        open_lock(path).map_err(|_| authority_error("target refresh lock is unavailable"))?;
    lock_registry(&lock, true)
        .map_err(|_| authority_error("target refresh lock could not be acquired"))?;
    Ok(TargetRefreshGuard(lock))
}

#[cfg(test)]
pub(crate) fn refresh_lock_is_held(
    directory: &Path,
    path: &Path,
) -> Result<bool, TargetAuthorityError> {
    create_private_directory(directory)
        .map_err(|_| authority_error("target refresh lock directory is unavailable"))?;
    let lock =
        open_lock(path).map_err(|_| authority_error("target refresh lock is unavailable"))?;
    match fs2::FileExt::try_lock_exclusive(&lock) {
        Ok(()) => {
            drop(TargetRefreshGuard(lock));
            Ok(false)
        }
        Err(error) if error.kind() == fs2::lock_contended_error().kind() => Ok(true),
        Err(_) => Err(authority_error("target refresh lock could not be acquired")),
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    pub struct MemoryCredentialStore {
        values: Mutex<BTreeMap<String, String>>,
    }

    pub struct UnavailableCredentialStore;

    #[derive(Default)]
    pub struct MemoryDeviceCodeNotifier {
        values: Mutex<Vec<(String, String)>>,
    }

    impl MemoryDeviceCodeNotifier {
        pub fn values(&self) -> Vec<(String, String)> {
            self.values
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }
    }

    impl DeviceCodeNotifier for MemoryDeviceCodeNotifier {
        fn show(&self, verification_uri: &str, user_code: &str) {
            self.values
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push((verification_uri.to_owned(), user_code.to_owned()));
        }
    }

    #[async_trait]
    impl TargetCredentialStore for UnavailableCredentialStore {
        async fn prepare_for_login(
            &self,
            _target_id: &str,
        ) -> Result<CredentialStorePreparation, TargetAuthorityError> {
            Err(authority_error("test credential store unavailable"))
        }

        async fn get(&self, _target_id: &str) -> Result<Option<String>, TargetAuthorityError> {
            Err(authority_error("test credential store unavailable"))
        }

        async fn set(
            &self,
            _target_id: &str,
            _refresh_token: &str,
        ) -> Result<(), TargetAuthorityError> {
            Err(authority_error("test credential store unavailable"))
        }
    }

    #[async_trait]
    impl TargetCredentialStore for MemoryCredentialStore {
        async fn get(&self, target_id: &str) -> Result<Option<String>, TargetAuthorityError> {
            Ok(self
                .values
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(target_id)
                .cloned())
        }

        async fn set(
            &self,
            target_id: &str,
            refresh_token: &str,
        ) -> Result<(), TargetAuthorityError> {
            self.values
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(target_id.to_owned(), refresh_token.to_owned());
            Ok(())
        }
    }
}
