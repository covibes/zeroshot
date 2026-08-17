use std::fmt;

use super::{FaultError, MAX_EPHEMERAL_DIAGNOSTIC_BYTES};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(usize)]
pub enum RedactionMarker {
    Path,
    Url,
    Header,
    RawFrame,
    StandardError,
    ProviderText,
    ToolArgument,
    ToolResult,
    SessionIdentifier,
    Credential,
    NestedCause,
    UnknownText,
}

const SANITIZED_MARKERS: [&str; 12] = [
    "[path redacted]",
    "[url redacted]",
    "[header redacted]",
    "[raw frame redacted]",
    "[stderr redacted]",
    "[provider text redacted]",
    "[tool argument redacted]",
    "[tool result redacted]",
    "[session identifier redacted]",
    "[credential redacted]",
    "[nested cause redacted]",
    "[unknown text redacted]",
];

impl RedactionMarker {
    fn sanitized(self) -> &'static str {
        SANITIZED_MARKERS
            .get(self as usize)
            .copied()
            .unwrap_or("[unknown text redacted]")
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub struct EphemeralDiagnostic {
    marker: RedactionMarker,
    sanitized: &'static str,
    original_bytes: u16,
}

impl EphemeralDiagnostic {
    #[must_use]
    pub const fn marker(&self) -> RedactionMarker {
        self.marker
    }

    #[must_use]
    pub const fn sanitized(&self) -> &'static str {
        self.sanitized
    }

    #[must_use]
    pub const fn original_bytes(&self) -> u16 {
        self.original_bytes
    }
}

impl fmt::Debug for EphemeralDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EphemeralDiagnostic")
            .field("marker", &self.marker)
            .field("value", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub struct RawDiagnostic {
    sanitized: EphemeralDiagnostic,
}

impl RawDiagnostic {
    pub fn new(marker: RedactionMarker, raw: &str) -> Result<Self, FaultError> {
        let raw_bytes = raw.len();
        if raw_bytes > MAX_EPHEMERAL_DIAGNOSTIC_BYTES {
            return Err(FaultError::DiagnosticTooLong);
        }
        let sanitized = marker.sanitized();
        debug_assert!(sanitized.len() <= MAX_EPHEMERAL_DIAGNOSTIC_BYTES);
        Ok(Self {
            sanitized: EphemeralDiagnostic {
                marker,
                sanitized,
                original_bytes: u16::try_from(raw_bytes)
                    .map_err(|_| FaultError::DiagnosticTooLong)?,
            },
        })
    }

    #[must_use]
    pub const fn ephemeral(&self) -> &EphemeralDiagnostic {
        &self.sanitized
    }
}

impl fmt::Debug for RawDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RawDiagnostic(<redacted>)")
    }
}
