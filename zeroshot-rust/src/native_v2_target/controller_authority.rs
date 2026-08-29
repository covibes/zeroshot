mod connections;
mod contract;
mod control;
pub(super) mod credentials;
mod hosted_runs;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::header::{ACCEPT, AUTHORIZATION, CACHE_CONTROL, HeaderValue};
use reqwest::{Client, Url};
use serde::de::DeserializeOwned;
use zeroshot_engine::native_v2_target_authority::{DISCOVERY_PATH, TargetDiscoveryDocument};

use self::contract::{
    build_auth_descriptor, build_controller_descriptor, validate_metadata_routes,
    ControllerDescriptor, DeviceCodeWire, DevicePoll, HostedAuthDescriptor, OAuthErrorWire,
    OAuthMetadataWire, TargetSessionWire, TokenWire, authority_error, parse_origin, read_json,
    require_response_route, validate_device_code, validate_secret, validate_token,
};
use self::credentials::{
    CredentialStorePreparation, DeviceCodeNotifier, StderrDeviceCodeNotifier, TargetRefreshGuard,
    credential_service, open_refresh_lock, production_target_credential_store,
};
use super::registry::default_target_registry_path;
use super::{TargetAccess, TargetAuthorityError, TargetRecord};

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
    stream_client: Client,
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
        let credentials =
            production_target_credential_store(refresh_lock_directory.join("credentials"))?;
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("zeroshot-rust/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| authority_error("target HTTP client could not be initialized"))?;
        let stream_client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("zeroshot-rust/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| authority_error("target HTTP client could not be initialized"))?;
        Ok(Self {
            client,
            stream_client,
            credentials,
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
            stream_client: Client::builder()
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
        let (origin, wire) = self.discovery(target).await?;
        let auth = build_auth_descriptor(&origin, &wire)?;
        let controller =
            build_controller_descriptor(&origin, wire, target.access.authentication())?;
        let metadata: OAuthMetadataWire =
            self.get_json(&auth.metadata_url, "OAuth metadata").await?;
        validate_metadata_routes(&origin, &auth, &metadata)?;
        Ok((auth, controller))
    }

    async fn discovery(
        &self,
        target: &TargetRecord,
    ) -> Result<(Url, TargetDiscoveryDocument), TargetAuthorityError> {
        let origin = parse_origin(&target.origin)?;
        let discovery_url = origin
            .join(DISCOVERY_PATH)
            .map_err(|_| authority_error("hosted target discovery URL is invalid"))?;
        let wire: TargetDiscoveryDocument = self
            .get_json(&discovery_url, "native-v2 target discovery")
            .await?;
        Ok((origin, wire))
    }

    async fn controller_descriptor(
        &self,
        target: &TargetRecord,
    ) -> Result<ControllerDescriptor, TargetAuthorityError> {
        let (origin, wire) = self.discovery(target).await?;
        build_controller_descriptor(&origin, wire, target.access.authentication())
    }

    async fn login_inner(&self, request: HostedLogin<'_>) -> Result<(), TargetAuthorityError> {
        if let CredentialStorePreparation::PrivateFile(path) = self
            .credentials
            .prepare_for_login(request.target_id)
            .await?
        {
            eprintln!(
                concat!(
                    "\nWarning: the refresh token will be stored unencrypted in this private ",
                    "file:\n  {}\nSet ZEROSHOT_RUST_CREDENTIAL_STORE=system to require Secret ",
                    "Service.\n"
                ),
                path.display()
            );
        }
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
            .map_err(|_| TargetAuthorityError::disconnected("device token request failed"))?;
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
            .map_err(|_| {
                TargetAuthorityError::disconnected("target session verification failed")
            })?;
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
            .map_err(|_| {
                TargetAuthorityError::disconnected(format!("{operation} request failed"))
            })?;
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
            .map_err(|_| {
                TargetAuthorityError::disconnected(format!("{operation} request failed"))
            })?;
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

enum TokenPollOutcome {
    Ready(TokenWire),
    Pending,
    SlowDown,
}

pub(super) use credentials::TargetCredentialStore;
