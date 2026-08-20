use std::fs::File;
use std::path::Path;

use async_trait::async_trait;

use super::authority_error;
use crate::native_v2_target::registry::{create_private_directory, lock_registry, open_lock};
use crate::native_v2_target::TargetAuthorityError;

#[async_trait]
pub(crate) trait TargetCredentialStore: Send + Sync {
    async fn get(&self, target_id: &str) -> Result<Option<String>, TargetAuthorityError>;
    async fn set(&self, target_id: &str, refresh_token: &str) -> Result<(), TargetAuthorityError>;
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
pub(crate) mod test_support {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    pub struct MemoryCredentialStore {
        values: Mutex<BTreeMap<String, String>>,
    }

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
