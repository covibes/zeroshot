use openengine_cluster_client::ClientError;

use crate::native_v2_cli::NativeV2CliError;

pub(super) fn protocol(error: ClientError) -> NativeV2CliError {
    crate::native_v2_cli::diagnostic::client_error(error)
}

pub(super) fn subscription(error: ClientError) -> NativeV2CliError {
    match error {
        ClientError::Transport(_) => NativeV2CliError::Disconnected,
        error => protocol(error),
    }
}

pub(super) fn require_named_target(target: Option<&str>) -> Result<&str, NativeV2CliError> {
    target.ok_or_else(|| {
        NativeV2CliError::Target("local controller composition is unavailable".to_owned())
    })
}
