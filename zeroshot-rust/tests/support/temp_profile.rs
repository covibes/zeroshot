use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use zeroshot_engine::daemon_discovery::NativeProfile;

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

pub struct TempProfile {
    pub profile: NativeProfile,
    root: PathBuf,
}

impl TempProfile {
    pub fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "zeroshot-daemon-{label}-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        Self {
            profile: NativeProfile::new(&root, format!("native-profile:{label}")),
            root,
        }
    }
}

impl Drop for TempProfile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
