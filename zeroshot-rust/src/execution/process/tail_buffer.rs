pub(super) struct TailBuffer {
    bytes: Vec<u8>,
    capacity: usize,
    truncated: bool,
}

pub(super) struct TailSnapshot {
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

impl TailBuffer {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(capacity),
            capacity,
            truncated: false,
        }
    }

    pub(super) fn append(&mut self, value: &[u8]) {
        if value.len() >= self.capacity {
            self.truncated |= !self.bytes.is_empty() || value.len() > self.capacity;
            self.bytes.clear();
            if let Some(tail) = value.get(value.len().saturating_sub(self.capacity)..) {
                self.bytes.extend_from_slice(tail);
            }
            return;
        }
        let required = self.bytes.len() + value.len();
        if required > self.capacity {
            let discard = required - self.capacity;
            self.bytes.copy_within(discard.., 0);
            self.bytes.truncate(self.bytes.len() - discard);
            self.truncated = true;
        }
        self.bytes.extend_from_slice(value);
    }

    pub(super) fn snapshot(&self) -> TailSnapshot {
        TailSnapshot {
            bytes: self.bytes.clone(),
            truncated: self.truncated,
        }
    }
}
