mod contract;
pub(super) mod credentials;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use reqwest::header::{ACCEPT, AUTHORIZATION, CACHE_CONTROL, HeaderValue};
use reqwest::{Client, Url};
use serde::de::DeserializeOwned;
use zeroshot_engine::native_v2_target_authority::{
    DISCOVERY_PATH, TargetDiscoveryDocument, TargetOecpSession, TargetRunReceipt, TargetRunRequest,
    TargetSetupOutcome, TargetSetupResult,
};
use openengine_cluster_protocol::{RunSubmitResult};

use self::contract::{
    build_auth_descriptor, build_controller_descriptor, validate_metadata_routes,
    ControllerDescriptor, DeviceCodeWire, DevicePoll, HostedAuthDescriptor, HostedDiscoveryWire,
    OAuthErrorWire, OAuthMetadataWire, TargetSessionWire, TokenWire, authority_error, parse_origin,
    read_json, require_response_route, validate_device_code, validate_hosted_discovery,
    validate_secret, validate_token,
};
use self::credentials::{
    DeviceCodeNotifier, KeyringTargetCredentialStore, StderrDeviceCodeNotifier, TargetRefreshGuard,
    credential_service, open_refresh_lock,
};
use super::registry::default_target_registry_path;
use super::{
    TargetAccess, TargetAuthorityError, TargetControlAuthority, TargetOecpAccess, TargetRecord,
    TargetSetupDocument,
};

const HOSTED_DISCOVERY_PATH: &str = "/.well-known/openengine-hosted-target";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const SESSION_KIND: &str = "openengine.target-session/v1";
const DEVICE_LABEL: &str = "zeroshot-cli";

struct HostedLogin<'a> {
    target_id: &'a str,
    device_token: &'a str,
    auth: &'a HostedAuthDescriptor,
    audience: &'a str,
}

/// One named-target HTTP authority. Hosted access retains the existing OAuth refresh-family flow;
/// explicit direct access never touches hosted discovery, the credential store, or Authorization.
#[derive(Clone)]
pub struct TargetHttpControlAuthority {
    client: Client,
    credentials: Arc<dyn TargetCredentialStore>,
    notifier: Arc<dyn DeviceCodeNotifier>,
    refresh_lock_directory: PathBuf,
}

impl TargetHttpControlAuthority {
    pub fn production() -> Result<Self, TargetAuthorityError> {
        let registry_path = default_target_registry_path()
            .map_err(|_| authority_error("target refresh lock path is unavailable"))?;
        let refresh_lock_directory = registry_path
            .parent()
            .ok_or_else(|| authority_error("target refresh lock path is unavailable"))?
            .to_owned();
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("zeroshot-rust/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| authority_error("target HTTP client could not be initialized"))?;
        Ok(Self {
            client,
            credentials: Arc::new(KeyringTargetCredentialStore),
            notifier: Arc::new(StderrDeviceCodeNotifier),
            refresh_lock_directory,
        })
    }

    #[cfg(test)]
    pub(super) fn with_dependencies(
        credentials: Arc<dyn TargetCredentialStore>,
        notifier: Arc<dyn DeviceCodeNotifier>,
        refresh_lock_directory: PathBuf,
    ) -> Self {
        Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_default(),
            credentials,
            notifier,
            refresh_lock_directory,
        }
    }

    async fn lock_refresh_family(
        &self,
        target_id: &str,
    ) -> Result<TargetRefreshGuard, TargetAuthorityError> {
        credential_service(target_id)?;
        let directory = self.refresh_lock_directory.clone();
        let path = directory.join(format!("target-{target_id}-refresh.lock"));
        tokio::task::spawn_blocking(move || open_refresh_lock(&directory, &path))
            .await
            .map_err(|_| authority_error("target refresh lock task failed"))?
    }

    async fn descriptors(
        &self,
        target: &TargetRecord,
    ) -> Result<(HostedAuthDescriptor, ControllerDescriptor), TargetAuthorityError> {
        let auth = self.auth_descriptor(target).await?;
        let controller = self.controller_descriptor(target).await?;
        Ok((auth, controller))
    }

    async fn auth_descriptor(
        &self,
        target: &TargetRecord,
    ) -> Result<HostedAuthDescriptor, TargetAuthorityError> {
        let origin = parse_origin(&target.origin)?;
        let discovery_url = origin
            .join(HOSTED_DISCOVERY_PATH)
            .map_err(|_| authority_error("hosted target discovery URL is invalid"))?;
        let wire: HostedDiscoveryWire = self.get_json(&discovery_url, "hosted discovery").await?;
        validate_hosted_discovery(&wire)?;
        let descriptor = build_auth_descriptor(&origin, wire)?;
        let metadata: OAuthMetadataWire = self
            .get_json(&descriptor.metadata_url, "OAuth metadata")
            .await?;
        validate_metadata_routes(&origin, &descriptor, &metadata)?;
        Ok(descriptor)
    }

    async fn controller_descriptor(
        &self,
        target: &TargetRecord,
    ) -> Result<ControllerDescriptor, TargetAuthorityError> {
        let origin = parse_origin(&target.origin)?;
        let discovery_url = origin
            .join(DISCOVERY_PATH)
            .map_err(|_| authority_error("controller discovery URL is invalid"))?;
        let wire: TargetDiscoveryDocument = self
            .get_json(&discovery_url, "native-v2 controller discovery")
            .await?;
        build_controller_descriptor(&origin, wire, target.access.authentication())
    }

    async fn login_inner(&self, request: HostedLogin<'_>) -> Result<(), TargetAuthorityError> {
        let code: DeviceCodeWire = self
            .post_form_json(
                &request.auth.device_authorization_endpoint,
                &[("client_id", request.auth.client_id.as_str())],
                "device authorization",
            )
            .await?;
        validate_device_code(&code)?;
        self.notifier.show(&code.verification_uri, &code.user_code);
        let token = self
            .poll_for_token(DevicePoll {
                device_token: request.device_token,
                auth: request.auth,
                audience: request.audience,
                code: &code,
            })
            .await?;
        self.verify_session(request.auth, &token.access_token)
            .await?;
        self.credentials
            .set(request.target_id, &token.refresh_token)
            .await
    }

    async fn poll_for_token(
        &self,
        request: DevicePoll<'_>,
    ) -> Result<TokenWire, TargetAuthorityError> {
        let deadline = Instant::now() + Duration::from_secs(request.code.expires_in);
        let mut delay = request.code.interval;
        loop {
            if Instant::now() >= deadline {
                return Err(authority_error("device authorization expired"));
            }
            tokio::time::sleep(Duration::from_secs(delay)).await;
            match self.poll_token_once(&request).await? {
                TokenPollOutcome::Ready(token) => return Ok(token),
                TokenPollOutcome::Pending => {}
                TokenPollOutcome::SlowDown => delay = delay.saturating_add(5).min(300),
            }
        }
    }

    async fn poll_token_once(
        &self,
        request: &DevicePoll<'_>,
    ) -> Result<TokenPollOutcome, TargetAuthorityError> {
        let response = self
            .client
            .post(request.auth.token_endpoint.clone())
            .form(&[
                ("grant_type", request.auth.device_grant_type.as_str()),
                ("device_code", request.code.device_code.as_str()),
                ("client_id", request.auth.client_id.as_str()),
                ("device_token", request.device_token),
                ("device_label", DEVICE_LABEL),
                ("audience", request.audience),
            ])
            .send()
            .await
            .map_err(|_| authority_error("device token request failed"))?;
        require_response_route(&response, &request.auth.token_endpoint)?;
        read_token_poll(response).await
    }
}

async fn read_token_poll(
    response: reqwest::Response,
) -> Result<TokenPollOutcome, TargetAuthorityError> {
    if response.status().is_success() {
        let token: TokenWire = read_json(response, "device token").await?;
        validate_token(&token)?;
        return Ok(TokenPollOutcome::Ready(token));
    }
    let error: OAuthErrorWire = read_json(response, "OAuth error").await?;
    match error.error.as_str() {
        "authorization_pending" => Ok(TokenPollOutcome::Pending),
        "slow_down" => Ok(TokenPollOutcome::SlowDown),
        "access_denied" => Err(authority_error("device authorization denied")),
        "expired_token" => Err(authority_error("device authorization expired")),
        _ => Err(authority_error("unsupported OAuth token response")),
    }
}

impl TargetHttpControlAuthority {
    async fn access_token(
        &self,
        target: &TargetRecord,
        auth: &HostedAuthDescriptor,
        audience: &str,
    ) -> Result<String, TargetAuthorityError> {
        let _refresh_guard = self.lock_refresh_family(&target.id).await?;
        let refresh_token = self
            .credentials
            .get(&target.id)
            .await?
            .ok_or_else(|| authority_error("target login required"))?;
        validate_secret(&refresh_token, "stored refresh token")?;
        let token: TokenWire = self
            .post_form_json(
                &auth.token_endpoint,
                &[
                    ("grant_type", "refresh_token"),
                    ("client_id", auth.client_id.as_str()),
                    ("refresh_token", refresh_token.as_str()),
                    ("audience", audience),
                ],
                "target token exchange",
            )
            .await?;
        validate_token(&token)?;
        self.verify_session(auth, &token.access_token).await?;
        self.credentials
            .set(&target.id, &token.refresh_token)
            .await?;
        Ok(token.access_token)
    }

    async fn verify_session(
        &self,
        auth: &HostedAuthDescriptor,
        access_token: &str,
    ) -> Result<(), TargetAuthorityError> {
        let response = self
            .authorized(self.client.get(auth.session_endpoint.clone()), access_token)?
            .header(ACCEPT, "application/json")
            .header(CACHE_CONTROL, "no-store")
            .send()
            .await
            .map_err(|_| authority_error("target session verification failed"))?;
        require_response_route(&response, &auth.session_endpoint)?;
        if !response.status().is_success() {
            return Err(authority_error("target session verification failed"));
        }
        let session: TargetSessionWire = read_json(response, "target session").await?;
        if session.kind != SESSION_KIND
            || session.organization_id.is_empty()
            || session.organization_id.len() > 256
        {
            return Err(authority_error("target session response is malformed"));
        }
        Ok(())
    }

    fn authorized(
        &self,
        request: reqwest::RequestBuilder,
        token: &str,
    ) -> Result<reqwest::RequestBuilder, TargetAuthorityError> {
        validate_secret(token, "access token")?;
        let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| authority_error("access token is malformed"))?;
        value.set_sensitive(true);
        Ok(request.header(AUTHORIZATION, value))
    }

    async fn controller_access(
        &self,
        target: &TargetRecord,
    ) -> Result<(ControllerDescriptor, Option<String>), TargetAuthorityError> {
        match &target.access {
            TargetAccess::Hosted { .. } => {
                let (auth, controller) = self.descriptors(target).await?;
                let access = self
                    .access_token(target, &auth, &controller.audience)
                    .await?;
                Ok((controller, Some(access)))
            }
            TargetAccess::Direct => Ok((self.controller_descriptor(target).await?, None)),
        }
    }

    fn with_access(
        &self,
        request: reqwest::RequestBuilder,
        access: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, TargetAuthorityError> {
        match access {
            Some(access) => self.authorized(request, access),
            None => Ok(request),
        }
    }

    async fn get_json<T: DeserializeOwned>(
        &self,
        url: &Url,
        operation: &'static str,
    ) -> Result<T, TargetAuthorityError> {
        let response = self
            .client
            .get(url.clone())
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| authority_error(format!("{operation} request failed")))?;
        require_response_route(&response, url)?;
        if !response.status().is_success() {
            return Err(authority_error(format!(
                "{operation} request failed with status {}",
                response.status().as_u16()
            )));
        }
        read_json(response, operation).await
    }

    async fn post_form_json<T: DeserializeOwned>(
        &self,
        url: &Url,
        form: &[(&str, &str)],
        operation: &'static str,
    ) -> Result<T, TargetAuthorityError> {
        let response = self
            .client
            .post(url.clone())
            .form(form)
            .send()
            .await
            .map_err(|_| authority_error(format!("{operation} request failed")))?;
        require_response_route(&response, url)?;
        if !response.status().is_success() {
            return Err(authority_error(format!(
                "{operation} request failed with status {}",
                response.status().as_u16()
            )));
        }
        read_json(response, operation).await
    }
}

#[async_trait]
impl TargetControlAuthority for TargetHttpControlAuthority {
    async fn discover(&self, target: &TargetRecord) -> Result<(), TargetAuthorityError> {
        match target.access {
            TargetAccess::Hosted { .. } => self.descriptors(target).await.map(|_| ()),
            TargetAccess::Direct => self.controller_descriptor(target).await.map(|_| ()),
        }
    }

    async fn login(&self, target: &TargetRecord) -> Result<(), TargetAuthorityError> {
        let device_token = target
            .access
            .device_token()
            .ok_or_else(|| authority_error("direct target does not use login"))?;
        let (auth, controller) = self.descriptors(target).await?;
        self.login_inner(HostedLogin {
            target_id: &target.id,
            device_token,
            auth: &auth,
            audience: &controller.audience,
        })
        .await
    }

    async fn install(
        &self,
        target: &TargetRecord,
        setup: &TargetSetupDocument,
    ) -> Result<(), TargetAuthorityError> {
        let (controller, access) = self.controller_access(target).await?;
        let response = self
            .with_access(
                self.client.put(controller.setup_url.clone()),
                access.as_deref(),
            )?
            .header(ACCEPT, "application/json")
            .json(setup)
            .send()
            .await
            .map_err(|_| authority_error("target setup request failed"))?;
        require_response_route(&response, &controller.setup_url)?;
        if !response.status().is_success() {
            return Err(authority_error(format!(
                "target setup request failed with status {}",
                response.status().as_u16()
            )));
        }
        let receipt: TargetSetupResult = read_json(response, "target setup").await?;
        match receipt.outcome {
            TargetSetupOutcome::Installed | TargetSetupOutcome::Unchanged => {}
        }
        Ok(())
    }

    async fn submit(
        &self,
        target: &TargetRecord,
        request: &TargetRunRequest,
    ) -> Result<RunSubmitResult, TargetAuthorityError> {
        let (controller, access) = self.controller_access(target).await?;
        let response = self
            .with_access(
                self.client.post(controller.run_url.clone()),
                access.as_deref(),
            )?
            .header(ACCEPT, "application/json")
            .json(request)
            .send()
            .await
            .map_err(|_| authority_error("target run request failed"))?;
        require_response_route(&response, &controller.run_url)?;
        if !response.status().is_success() {
            return Err(authority_error(format!(
                "target run request failed with status {}",
                response.status().as_u16()
            )));
        }
        let receipt: TargetRunReceipt = read_json(response, "target run").await?;
        Ok(RunSubmitResult {
            run_id: receipt.run_id,
        })
    }

    async fn oecp_session(
        &self,
        target: &TargetRecord,
    ) -> Result<TargetOecpAccess, TargetAuthorityError> {
        let (controller, access) = self.controller_access(target).await?;
        let response = self
            .with_access(
                self.client.post(controller.session_url.clone()),
                access.as_deref(),
            )?
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| authority_error("target OECP session request failed"))?;
        require_response_route(&response, &controller.session_url)?;
        if !response.status().is_success() {
            return Err(authority_error(format!(
                "target OECP session request failed with status {}",
                response.status().as_u16()
            )));
        }
        let session: TargetOecpSession = read_json(response, "target OECP session").await?;
        TargetOecpAccess::new(session.endpoint, session.bearer_token, &target.access)
            .map_err(|_| authority_error("target OECP session response is malformed"))
    }
}

enum TokenPollOutcome {
    Ready(TokenWire),
    Pending,
    SlowDown,
}

pub(super) use credentials::TargetCredentialStore;
