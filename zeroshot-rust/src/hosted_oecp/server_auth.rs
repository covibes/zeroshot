use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::time::Duration;

pub const OECP_CAPABILITY_FILE_ENV: &str = "ZEROSHOT_OECP_CAPABILITY_FILE";
pub(super) const AUTHENTICATION_DEADLINE: Duration = Duration::from_secs(5);
const MAX_OECP_FRAME_BYTES: usize = 1_048_576;
const MIN_CAPABILITY_BYTES: usize = 32;
const MAX_CAPABILITY_BYTES: usize = 256;
const MAX_CAPABILITY_FILE_BYTES: u64 = (MAX_CAPABILITY_BYTES + 2) as u64;
const CAPSULE_AGENT_UID: u32 = 1000;

pub(super) struct TransportCapability {
    bytes: [u8; MAX_CAPABILITY_BYTES],
    len: usize,
}

impl TransportCapability {
    pub(super) fn parse(token: &[u8]) -> io::Result<Self> {
        if !(MIN_CAPABILITY_BYTES..=MAX_CAPABILITY_BYTES).contains(&token.len())
            || !token.iter().all(u8::is_ascii_graphic)
        {
            return Err(authentication_error());
        }
        let mut bytes = [0; MAX_CAPABILITY_BYTES];
        bytes[..token.len()].copy_from_slice(token);
        Ok(Self {
            bytes,
            len: token.len(),
        })
    }

    fn matches(&self, candidate: &[u8]) -> bool {
        let mut candidate_bytes = [0; MAX_CAPABILITY_BYTES];
        if candidate.len() <= MAX_CAPABILITY_BYTES {
            candidate_bytes[..candidate.len()].copy_from_slice(candidate);
        }
        let mut difference = self.len ^ candidate.len();
        for (expected, presented) in self.bytes.iter().zip(candidate_bytes) {
            difference |= usize::from(expected ^ presented);
        }
        difference == 0
    }
}

impl Drop for TransportCapability {
    fn drop(&mut self) {
        self.bytes.fill(0);
        self.len = 0;
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthenticationEnvelope<'a> {
    #[serde(borrow)]
    #[serde(rename = "_zeroshotOecpTransport")]
    transport: AuthenticationField<'a>,
    #[serde(borrow)]
    request: &'a RawValue,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthenticationField<'a> {
    capability: &'a str,
}

pub(super) async fn authenticate_first_request<R>(
    reader: &mut R,
    capability: &TransportCapability,
) -> io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let received = read_first_frame(reader).await?;
    let newline = received
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(authentication_error)?;
    if newline > MAX_OECP_FRAME_BYTES {
        return Err(authentication_error());
    }
    let frame = &received[..newline];
    if is_http_preface(frame) {
        return Err(authentication_error());
    }
    let envelope: AuthenticationEnvelope<'_> =
        serde_json::from_slice(frame).map_err(|_| authentication_error())?;
    if !capability.matches(envelope.transport.capability.as_bytes()) {
        return Err(authentication_error());
    }
    let request = envelope.request.get().as_bytes();
    if request.len() > MAX_OECP_FRAME_BYTES {
        return Err(authentication_error());
    }
    let mut authenticated =
        Vec::with_capacity(request.len() + 1 + received.len().saturating_sub(newline + 1));
    authenticated.extend_from_slice(request);
    authenticated.push(b'\n');
    authenticated.extend_from_slice(&received[newline + 1..]);
    Ok(authenticated)
}

async fn read_first_frame<R>(reader: &mut R) -> io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut received = Vec::with_capacity(4096);
    loop {
        if received.contains(&b'\n') {
            return Ok(received);
        }
        if received.len() > MAX_OECP_FRAME_BYTES {
            return Err(authentication_error());
        }
        let mut chunk = [0; 4096];
        let remaining = MAX_OECP_FRAME_BYTES
            .saturating_add(1)
            .saturating_sub(received.len());
        let read_len = remaining.min(chunk.len());
        let read = reader.read(&mut chunk[..read_len]).await?;
        if read == 0 {
            return Err(authentication_error());
        }
        received.extend_from_slice(&chunk[..read]);
    }
}

fn is_http_preface(frame: &[u8]) -> bool {
    const METHODS: [&[u8]; 9] = [
        b"GET ",
        b"POST ",
        b"HEAD ",
        b"OPTIONS ",
        b"CONNECT ",
        b"PUT ",
        b"PATCH ",
        b"DELETE ",
        b"TRACE ",
    ];
    METHODS.iter().any(|method| frame.starts_with(method)) || frame.starts_with(b"PRI * HTTP/2.0")
}

pub(super) fn load_transport_capability() -> io::Result<TransportCapability> {
    let path = std::env::var_os(OECP_CAPABILITY_FILE_ENV)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(authentication_error)?;
    let mut file = open_capability_file(&path)?;
    let metadata = file.metadata()?;
    verify_capability_metadata(&metadata)?;
    if metadata.len() > MAX_CAPABILITY_FILE_BYTES {
        return Err(authentication_error());
    }
    let mut token = Vec::with_capacity(MAX_CAPABILITY_FILE_BYTES as usize);
    std::io::Read::by_ref(&mut file)
        .take(MAX_CAPABILITY_FILE_BYTES + 1)
        .read_to_end(&mut token)?;
    if token.len() as u64 > MAX_CAPABILITY_FILE_BYTES {
        return Err(authentication_error());
    }
    if token.ends_with(b"\r\n") {
        token.truncate(token.len() - 2);
    } else if token.ends_with(b"\n") {
        token.pop();
    }
    TransportCapability::parse(&token)
}

#[cfg(unix)]
fn open_capability_file(path: &Path) -> io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
}

#[cfg(not(unix))]
fn open_capability_file(_path: &Path) -> io::Result<std::fs::File> {
    Err(authentication_error())
}

#[cfg(unix)]
fn verify_capability_metadata(metadata: &std::fs::Metadata) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;

    if metadata.is_file()
        && matches!(metadata.uid(), 0 | CAPSULE_AGENT_UID)
        && metadata.mode() & 0o7777 == 0o400
        && metadata.nlink() == 1
    {
        Ok(())
    } else {
        Err(authentication_error())
    }
}

#[cfg(not(unix))]
fn verify_capability_metadata(_metadata: &std::fs::Metadata) -> io::Result<()> {
    Err(authentication_error())
}

pub(super) fn authentication_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "hosted OECP authentication failed",
    )
}
