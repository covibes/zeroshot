use std::path::PathBuf;

use super::WorkspaceAccessMode;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceCapability {
    pub current_dir: PathBuf,
    pub mode: WorkspaceAccessMode,
}

#[derive(Clone, Debug)]
pub struct DriverCancellation {
    cancelled: tokio::sync::watch::Receiver<bool>,
}

impl DriverCancellation {
    pub fn new(cancelled: tokio::sync::watch::Receiver<bool>) -> Self {
        Self { cancelled }
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }

    pub async fn cancelled(&mut self) {
        while !*self.cancelled.borrow() {
            if self.cancelled.changed().await.is_err() {
                break;
            }
        }
    }
}
