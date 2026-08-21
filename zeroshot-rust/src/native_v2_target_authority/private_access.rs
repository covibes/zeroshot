use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;

use openengine_cluster_protocol::TargetPrivateBootstrapRequest;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use tokio::sync::Mutex;

use super::TargetAuthorityError;

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const TOKEN_BYTES: usize = 64;
const TAG_BYTES: usize = 16;
// Zero Cloud already uses this purpose-bound envelope. Keeping the exact domain lets the native
// target replace the capsule agent without a second task-key scheme.
const AAD: &[u8] = b"zeroshot-capsule-bootstrap-v1";

/// One bootstrap key consumed from a private file and zeroized after the first accepted payload.
pub struct TargetBootstrapKey([u8; KEY_BYTES]);

impl TargetBootstrapKey {
    pub fn load_and_unlink(path: &Path) -> Result<Self, TargetAuthorityError> {
        let result = read_private_key(path);
        let removed = std::fs::remove_file(path);
        match (result, removed) {
            (Ok(key), Ok(())) => Ok(key),
            _ => Err(TargetAuthorityError::invalid(
                "private bootstrap key file is unavailable",
            )),
        }
    }

    fn open(
        &self,
        request: &TargetPrivateBootstrapRequest,
    ) -> Result<PrivateTargetToken, TargetAuthorityError> {
        let nonce = decode_lower::<NONCE_BYTES>(&request.nonce)?;
        let nonce = Nonce::assume_unique_for_key(nonce);
        let mut ciphertext = decode_lower_vec(&request.ciphertext)?;
        if ciphertext.len() != TOKEN_BYTES + TAG_BYTES {
            return Err(TargetAuthorityError::invalid(
                "private bootstrap payload is invalid",
            ));
        }
        let key = UnboundKey::new(&AES_256_GCM, &self.0)
            .map_err(|_| TargetAuthorityError::invalid("private bootstrap payload is invalid"))?;
        let key = LessSafeKey::new(key);
        let plaintext = key
            .open_in_place(nonce, Aad::from(AAD), &mut ciphertext)
            .map_err(|_| TargetAuthorityError::invalid("private bootstrap payload is invalid"))?;
        PrivateTargetToken::parse(plaintext)
    }
}

impl Drop for TargetBootstrapKey {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

struct PrivateTargetToken([u8; TOKEN_BYTES]);

impl PrivateTargetToken {
    fn parse(value: &[u8]) -> Result<Self, TargetAuthorityError> {
        if value.len() != TOKEN_BYTES || !value.iter().copied().all(is_lower_hex) {
            return Err(TargetAuthorityError::invalid(
                "private bootstrap payload is invalid",
            ));
        }
        let mut bytes = [0_u8; TOKEN_BYTES];
        bytes.copy_from_slice(value);
        Ok(Self(bytes))
    }

    fn matches(&self, candidate: &str) -> bool {
        let bytes = candidate.as_bytes();
        if bytes.len() != TOKEN_BYTES {
            return false;
        }
        self.0
            .iter()
            .zip(bytes)
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
    }

    fn expose(&self) -> &str {
        // Construction accepts only lowercase ASCII hexadecimal.
        std::str::from_utf8(&self.0).unwrap_or("")
    }
}

impl Drop for PrivateTargetToken {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

/// One-time state shared by submission, session, and OECP authentication.
pub struct PrivateTargetAccess {
    state: Mutex<PrivateAccessState>,
}

struct PrivateAccessState {
    bootstrap_key: Option<TargetBootstrapKey>,
    token: Option<PrivateTargetToken>,
}

impl PrivateTargetAccess {
    #[must_use]
    pub fn new(bootstrap_key: TargetBootstrapKey) -> Self {
        Self {
            state: Mutex::new(PrivateAccessState {
                bootstrap_key: Some(bootstrap_key),
                token: None,
            }),
        }
    }

    pub async fn bootstrap(
        &self,
        request: &TargetPrivateBootstrapRequest,
    ) -> Result<(), TargetAuthorityError> {
        let mut state = self.state.lock().await;
        let token = state
            .bootstrap_key
            .as_ref()
            .ok_or_else(|| TargetAuthorityError::unavailable("private bootstrap is closed"))?
            .open(request)?;
        drop(state.bootstrap_key.take());
        state.token = Some(token);
        Ok(())
    }

    pub async fn authenticate(&self, bearer: &str) -> Result<(), TargetAuthorityError> {
        self.state
            .lock()
            .await
            .token
            .as_ref()
            .is_some_and(|token| token.matches(bearer))
            .then_some(())
            .ok_or_else(TargetAuthorityError::unauthorized)
    }

    pub async fn token(&self) -> Result<String, TargetAuthorityError> {
        self.state
            .lock()
            .await
            .token
            .as_ref()
            .map(|token| token.expose().to_owned())
            .ok_or_else(TargetAuthorityError::unauthorized)
    }
}

fn read_private_key(path: &Path) -> Result<TargetBootstrapKey, TargetAuthorityError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|_| TargetAuthorityError::invalid("private bootstrap key file is unavailable"))?;
    let metadata = file
        .metadata()
        .map_err(|_| TargetAuthorityError::invalid("private bootstrap key file is unavailable"))?;
    if !metadata.is_file() || !private_file_metadata(&metadata) {
        return Err(TargetAuthorityError::invalid(
            "private bootstrap key file is unavailable",
        ));
    }
    let mut encoded = Vec::with_capacity(KEY_BYTES * 2);
    file.by_ref()
        .take((KEY_BYTES * 2 + 1) as u64)
        .read_to_end(&mut encoded)
        .map_err(|_| TargetAuthorityError::invalid("private bootstrap key file is unavailable"))?;
    if encoded.len() != KEY_BYTES * 2 {
        return Err(TargetAuthorityError::invalid(
            "private bootstrap key file is unavailable",
        ));
    }
    let decoded = decode_lower_vec(std::str::from_utf8(&encoded).map_err(|_| {
        TargetAuthorityError::invalid("private bootstrap key file is unavailable")
    })?)?;
    let bytes = decoded
        .try_into()
        .map_err(|_| TargetAuthorityError::invalid("private bootstrap key file is unavailable"))?;
    Ok(TargetBootstrapKey(bytes))
}

#[cfg(unix)]
fn private_file_metadata(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.mode() & 0o777 == 0o600
        && metadata.nlink() == 1
        && metadata.uid() == unsafe { libc::geteuid() }
}

#[cfg(not(unix))]
fn private_file_metadata(_metadata: &std::fs::Metadata) -> bool {
    true
}

fn decode_lower<const N: usize>(value: &str) -> Result<[u8; N], TargetAuthorityError> {
    decode_lower_vec(value)?
        .try_into()
        .map_err(|_| TargetAuthorityError::invalid("private bootstrap payload is invalid"))
}

fn decode_lower_vec(value: &str) -> Result<Vec<u8>, TargetAuthorityError> {
    if value.len() % 2 != 0 || !value.bytes().all(is_lower_hex) {
        return Err(TargetAuthorityError::invalid(
            "private bootstrap payload is invalid",
        ));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| match pair {
            [high, low] => Ok((decode_nibble(*high)? << 4) | decode_nibble(*low)?),
            _ => Err(TargetAuthorityError::invalid(
                "private bootstrap payload is invalid",
            )),
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn encode_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

fn decode_nibble(byte: u8) -> Result<u8, TargetAuthorityError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(TargetAuthorityError::invalid(
            "private bootstrap payload is invalid",
        )),
    }
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[tokio::test]
    async fn bootstrap_is_authenticated_one_time_and_constant_shape() {
        let access = PrivateTargetAccess::new(TargetBootstrapKey([7; KEY_BYTES]));
        let key = UnboundKey::new(&AES_256_GCM, &[7; KEY_BYTES]);
        assert!(key.is_ok());
        let Ok(key) = key else {
            return;
        };
        let key = LessSafeKey::new(key);
        let mut ciphertext = TOKEN.as_bytes().to_vec();
        let nonce = [11; NONCE_BYTES];
        let sealed = key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(AAD),
            &mut ciphertext,
        );
        assert!(sealed.is_ok());
        if sealed.is_err() {
            return;
        }
        let request = TargetPrivateBootstrapRequest {
            nonce: encode_lower(&nonce),
            ciphertext: encode_lower(&ciphertext),
        };
        assert!(access.bootstrap(&request).await.is_ok());
        assert!(access.authenticate(TOKEN).await.is_ok());
        assert!(access.authenticate(&"b".repeat(TOKEN_BYTES)).await.is_err());
        assert!(access.bootstrap(&request).await.is_err());
    }

    #[test]
    #[cfg(unix)]
    fn bootstrap_file_is_private_and_unlinked() {
        let root = std::env::temp_dir().join(format!("zeroshot-private-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        assert!(std::fs::create_dir(&root).is_ok());
        let path = root.join("key");
        assert!(std::fs::write(&path, "07".repeat(KEY_BYTES)).is_ok());
        assert!(std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).is_ok());
        assert!(TargetBootstrapKey::load_and_unlink(&path).is_ok());
        assert!(!path.exists());
        let _ = std::fs::remove_dir(&root);
    }
}
