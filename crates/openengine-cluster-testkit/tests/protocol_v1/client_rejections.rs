use super::*;

struct FixedResponseTransport(String);

#[async_trait]
impl JsonRpcTransport for FixedResponseTransport {
    async fn request(&self, _request: String) -> Result<String, TransportError> {
        Ok(self.0.clone())
    }
}

fn initialize_response(id: &str, version: &str) -> String {
    format!(
        concat!(
            r#"{{"jsonrpc":"2.0",{id}"result":{{"protocolVersion":"{version}","#,
            r#""capabilities":{{}},"status":{{"phase":"empty","observedGeneration":null,"#,
            r#""currentRunId":null,"atCursor":null}}}}}}"#
        ),
        id = id,
        version = version
    )
}

#[tokio::test]
async fn client_rejects_a_response_with_the_wrong_id() {
    let client = ClusterClient::new(FixedResponseTransport(initialize_response(
        r#""id":2,"#,
        "openengine.cluster/v1",
    )));

    let error = client.initialize().await.assert_error();
    let rejected = matches!(
        error,
        ClientError::InvalidResponse(message) if message.contains("id mismatch")
    );
    assert!(rejected);
}

#[tokio::test]
async fn client_rejects_a_success_with_the_wrong_protocol_version() {
    let client = ClusterClient::new(FixedResponseTransport(initialize_response(
        r#""id":1,"#,
        "openengine.cluster/v0",
    )));

    let error = client.initialize().await.assert_error();
    let rejected = matches!(
        error,
        ClientError::InvalidResponse(message) if message.contains("protocol version mismatch")
    );
    assert!(rejected);
}

#[tokio::test]
async fn client_rejects_a_success_that_does_not_echo_the_requested_version() {
    let client = ClusterClient::new(FixedResponseTransport(initialize_response(
        r#""id":1,"#,
        "openengine.cluster/v1",
    )));

    let error = client
        .initialize_with_version("openengine.cluster/v0")
        .await
        .assert_error();
    let rejected = matches!(
        error,
        ClientError::InvalidResponse(message)
            if message.contains("requested openengine.cluster/v0")
                && message.contains("received openengine.cluster/v1")
    );
    assert!(rejected);
}

#[tokio::test]
async fn client_rejects_success_responses_without_a_non_null_id() {
    for response in [
        initialize_response("", "openengine.cluster/v1"),
        initialize_response(r#""id":null,"#, "openengine.cluster/v1"),
    ] {
        let client = ClusterClient::new(FixedResponseTransport(response));
        assert!(matches!(
            client.initialize().await.assert_error(),
            ClientError::InvalidResponse(_)
        ));
    }
}
