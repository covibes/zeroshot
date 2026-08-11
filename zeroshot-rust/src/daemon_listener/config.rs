use std::time::Duration;

#[derive(Clone, Copy, Debug)]
pub struct ListenerConfig {
    pub startup_lock_timeout: Duration,
    pub liveness_timeout: Duration,
    pub handshake_timeout: Duration,
    pub drain_timeout: Duration,
    pub shutdown_timeout: Duration,
    pub max_active_connections: usize,
    pub max_pending_handshakes: usize,
    pub max_liveness_connections: usize,
}

impl Default for ListenerConfig {
    fn default() -> Self {
        Self {
            startup_lock_timeout: Duration::from_secs(1),
            liveness_timeout: Duration::from_millis(500),
            handshake_timeout: Duration::from_secs(2),
            drain_timeout: Duration::from_millis(250),
            shutdown_timeout: Duration::from_secs(1),
            max_active_connections: 64,
            max_pending_handshakes: 64,
            max_liveness_connections: 8,
        }
    }
}
