use std::io;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostedAuthorityConfig {
    pub repository: String,
    pub base_revision: String,
    pub provider: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostedAuthority {
    repository: String,
    base_revision: String,
    provider: String,
}

impl HostedAuthority {
    pub fn new(config: HostedAuthorityConfig) -> io::Result<Self> {
        let HostedAuthorityConfig {
            repository,
            base_revision,
            provider,
        } = config;
        if !valid_repository(&repository)
            || !valid_revision(&base_revision)
            || !valid_identifier(&provider, 64)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "hosted runtime authority is invalid",
            ));
        }
        Ok(Self {
            repository,
            base_revision,
            provider,
        })
    }

    #[must_use]
    pub fn repository(&self) -> &str {
        &self.repository
    }

    #[must_use]
    pub fn base_revision(&self) -> &str {
        &self.base_revision
    }

    #[must_use]
    pub fn provider(&self) -> &str {
        &self.provider
    }
}

pub(super) fn valid_repository(value: &str) -> bool {
    let mut parts = value.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    !owner.is_empty()
        && owner.len() <= 100
        && !name.is_empty()
        && name.len() <= 100
        && !matches!(owner, "." | "..")
        && !matches!(name, "." | "..")
        && !name.ends_with(".git")
        && parts.next().is_none()
        && owner.bytes().all(valid_repo_byte)
        && name.bytes().all(valid_repo_byte)
}

pub(super) fn valid_revision(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub(super) fn valid_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn valid_repo_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
}

#[cfg(test)]
mod tests {
    use super::{HostedAuthority, HostedAuthorityConfig};

    #[test]
    fn accepts_provider_neutral_installed_authority() {
        let authority = HostedAuthority::new(HostedAuthorityConfig {
            repository: "the-open-engine/zeroshot".to_owned(),
            base_revision: "a".repeat(40),
            provider: "future-provider".to_owned(),
        })
        .unwrap();
        assert_eq!(authority.repository(), "the-open-engine/zeroshot");
        assert_eq!(authority.base_revision(), "a".repeat(40));
        assert_eq!(authority.provider(), "future-provider");
    }

    #[test]
    fn rejects_noncanonical_repository_base_or_runtime_identifier() {
        for (repository, revision, provider) in [
            ("owner/repo/extra", "a".repeat(40), "provider"),
            ("owner/repo.git", "a".repeat(40), "provider"),
            ("owner/repo", "abc".to_owned(), "provider"),
            ("owner/repo", "a".repeat(40), "provider with spaces"),
        ] {
            assert!(
                HostedAuthority::new(HostedAuthorityConfig {
                    repository: repository.to_owned(),
                    base_revision: revision,
                    provider: provider.to_owned(),
                })
                .is_err()
            );
        }
    }
}
