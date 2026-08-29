use std::sync::Arc;

use serde_json::json;

use super::CapturedHttpRequest;
use super::super::fixtures::TempRoot;
use super::super::super::controller_authority::credentials::test_support::{
    MemoryCredentialStore, MemoryDeviceCodeNotifier,
};
use super::super::super::TargetHttpControlAuthority;

pub(in crate::native_v2_target::tests) fn test_authority(
    root: &TempRoot,
) -> (Arc<MemoryCredentialStore>, TargetHttpControlAuthority) {
    let credentials = Arc::new(MemoryCredentialStore::default());
    let authority = TargetHttpControlAuthority::with_dependencies(
        credentials.clone(),
        Arc::new(MemoryDeviceCodeNotifier::default()),
        root.path("refresh-locks"),
    );
    (credentials, authority)
}

pub(super) fn response(request: &CapturedHttpRequest) -> Option<String> {
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/native-v2/connections/list") => Some(
            json!({
                "connections": [{
                    "key": "github",
                    "scope": "user",
                    "kind": "static",
                    "fields": ["GH_TOKEN"]
                }]
            })
            .to_string(),
        ),
        ("POST", "/native-v2/connections/set") => Some(
            json!({
                "connection": {
                    "key": "github",
                    "scope": "user",
                    "kind": "static",
                    "fields": ["GH_TOKEN"]
                }
            })
            .to_string(),
        ),
        ("POST", "/native-v2/connections/delete") => Some(json!({"deleted": true}).to_string()),
        _ => None,
    }
}
