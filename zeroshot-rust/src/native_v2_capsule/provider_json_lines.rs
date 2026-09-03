//! Streaming framing for provider-owned JSON Lines output.
//!
//! Provider turns may legitimately produce an unbounded number of records. This helper therefore
//! bounds only one unfinished record, which is the memory it retains between process chunks.

pub(crate) const MAX_PROVIDER_JSONL_RECORD_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum ProviderJsonLine {
    Record(Vec<u8>),
    Oversized,
}

pub(crate) struct ProviderJsonLines {
    pending: Vec<u8>,
    discarding_oversized: bool,
    max_record_bytes: usize,
}

impl ProviderJsonLines {
    pub(crate) fn new() -> Self {
        Self::with_max_record_bytes(MAX_PROVIDER_JSONL_RECORD_BYTES)
    }

    fn with_max_record_bytes(max_record_bytes: usize) -> Self {
        Self {
            pending: Vec::new(),
            discarding_oversized: false,
            max_record_bytes,
        }
    }

    pub(crate) fn push(&mut self, bytes: &[u8]) -> Vec<ProviderJsonLine> {
        let mut records = Vec::new();
        let mut start = 0;
        for (end, byte) in bytes.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            self.append(bytes.get(start..end).unwrap_or_default());
            records.push(self.complete_record());
            start = end + 1;
        }
        self.append(bytes.get(start..).unwrap_or_default());
        records
    }

    pub(crate) fn finish(&mut self) -> Option<ProviderJsonLine> {
        if self.pending.is_empty() && !self.discarding_oversized {
            return None;
        }
        Some(self.complete_record())
    }

    pub(crate) fn discard(&mut self) {
        self.pending = Vec::new();
        self.discarding_oversized = false;
    }

    fn append(&mut self, bytes: &[u8]) {
        if self.discarding_oversized {
            return;
        }
        if bytes.len() <= self.max_record_bytes.saturating_sub(self.pending.len()) {
            self.pending.extend_from_slice(bytes);
            return;
        }
        self.pending = Vec::new();
        self.discarding_oversized = true;
    }

    fn complete_record(&mut self) -> ProviderJsonLine {
        if self.discarding_oversized {
            self.discarding_oversized = false;
            return ProviderJsonLine::Oversized;
        }
        let mut record = std::mem::take(&mut self.pending);
        if record.last() == Some(&b'\r') {
            record.pop();
        }
        ProviderJsonLine::Record(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_split_crlf_blank_and_unterminated_records() {
        let mut lines = ProviderJsonLines::with_max_record_bytes(64);
        assert!(lines.push(b"{\"a\":").is_empty());
        assert_eq!(
            lines.push(b"1}\r\n\nlast"),
            [
                ProviderJsonLine::Record(br#"{"a":1}"#.to_vec()),
                ProviderJsonLine::Record(Vec::new()),
            ]
        );
        assert_eq!(
            lines.finish(),
            Some(ProviderJsonLine::Record(b"last".to_vec()))
        );
        assert_eq!(lines.finish(), None);
    }

    #[test]
    fn discards_only_the_oversized_record_and_recovers() {
        let mut lines = ProviderJsonLines::with_max_record_bytes(4);
        assert_eq!(
            lines.push(b"1234\n12345\nok\n"),
            [
                ProviderJsonLine::Record(b"1234".to_vec()),
                ProviderJsonLine::Oversized,
                ProviderJsonLine::Record(b"ok".to_vec()),
            ]
        );
    }

    #[test]
    fn discards_an_oversized_record_across_chunks_and_at_eof() {
        let mut lines = ProviderJsonLines::with_max_record_bytes(4);
        assert!(lines.push(b"123").is_empty());
        assert!(lines.push(b"45").is_empty());
        assert_eq!(lines.finish(), Some(ProviderJsonLine::Oversized));

        assert!(lines.push(b"good").is_empty());
        assert_eq!(
            lines.finish(),
            Some(ProviderJsonLine::Record(b"good".to_vec()))
        );
    }

    #[test]
    fn releases_the_pending_allocation_when_a_record_is_discarded() {
        let mut lines = ProviderJsonLines::with_max_record_bytes(4);
        assert!(lines.push(b"1234").is_empty());
        assert!(lines.pending.capacity() >= 4);
        assert!(lines.push(b"5").is_empty());
        assert_eq!(lines.pending.capacity(), 0);
        lines.discard();
        assert_eq!(lines.pending.capacity(), 0);
    }
}
