// api_client.rs — Thin reqwest wrapper around the SVP server API.
//
// One ApiClient per AppState. Holds the bearer token after login and refreshes
// transparently. Automatically retries once on 401 by exchanging the refresh
// token; a second 401 surfaces to the caller as Auth("session expired").

use std::sync::Arc;
use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::errors::AppError;


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: String,
    pub email: String,
    pub tenant_id: String,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptorRegisterResponse {
    pub encryptor_device_id: String,
    pub master_key_hex: String,
    pub seats_used: u32,
    pub seats_total: u32,
    pub is_first_registration: bool,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptorRefreshKeyResponse {
    pub master_key_hex: String,
}


#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QualityEncryptionParams {
    pub salt: String,
    pub nonce: String,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterEncryptedVideoRequest {
    pub video_id: String,
    pub title: String,
    pub duration_ms: u64,
    pub qualities: Vec<String>,
    pub encryption_params: std::collections::BTreeMap<String, QualityEncryptionParams>,
    pub content_hashes: std::collections::BTreeMap<String, String>,
    pub file_sizes: std::collections::BTreeMap<String, u64>,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterEncryptedVideoResponse {
    pub video_id: String,
    pub status: String,
    pub qualities: Vec<String>,
    pub needs_download_urls_for: Vec<String>,
}


#[derive(Debug, Default)]
struct Tokens {
    access: Option<String>,
    refresh: Option<String>,
}


pub struct ApiClient {
    base_url: String,
    http: Client,
    tokens: Arc<RwLock<Tokens>>,
}


/// Turn a non-success HTTP response into a clean, user-facing message.
///
/// ENC-001: never leak reqwest's raw `<code> <reason>` status line (e.g.
/// "429 Too Many Requests") into the UI. We prefer FastAPI's JSON `detail`
/// field (a human-friendly string), and otherwise fall back to a short
/// message keyed off the status class.
async fn friendly_http_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    // FastAPI returns {"detail": "..."} for handled errors. `detail` may also
    // be an array (request-validation errors); only surface a plain string.
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
        if let Some(detail) = json.get("detail").and_then(|v| v.as_str()) {
            let detail = detail.trim();
            if !detail.is_empty() {
                return detail.to_string();
            }
        }
    }

    // No usable detail — friendly fallback by status class. We deliberately do
    // not include `status` (its Display renders the raw reason phrase).
    match status {
        StatusCode::TOO_MANY_REQUESTS => {
            "Too many requests right now — you may have hit a rate limit or seat cap. Please wait a moment and try again.".to_string()
        }
        StatusCode::UNAUTHORIZED => {
            "Not authorized — please log in again.".to_string()
        }
        StatusCode::FORBIDDEN => {
            "You don't have permission to perform this action.".to_string()
        }
        StatusCode::NOT_FOUND => {
            "The requested resource was not found.".to_string()
        }
        s if s.is_server_error() => {
            "The server ran into a problem. Please try again shortly.".to_string()
        }
        _ => "The request could not be completed. Please try again.".to_string(),
    }
}


impl ApiClient {
    pub fn new(base_url: impl Into<String>) -> Result<Self, AppError> {
        let http = Client::builder()
            // Encryption metadata posts are tiny but Drive-hosted file uploads
            // are not our concern; keep server-call timeouts short-ish.
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http,
            tokens: Arc::new(RwLock::new(Tokens::default())),
        })
    }

    pub fn set_base_url(&mut self, url: impl Into<String>) {
        self.base_url = url.into().trim_end_matches('/').to_string();
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub async fn set_tokens(&self, access: String, refresh: String) {
        let mut t = self.tokens.write().await;
        t.access = Some(access);
        t.refresh = Some(refresh);
    }

    pub async fn clear_tokens(&self) {
        let mut t = self.tokens.write().await;
        t.access = None;
        t.refresh = None;
    }

    pub async fn access_token(&self) -> Option<String> {
        self.tokens.read().await.access.clone()
    }

    pub async fn is_authenticated(&self) -> bool {
        self.tokens.read().await.access.is_some()
    }

    async fn auth_header(&self) -> Option<String> {
        self.tokens
            .read()
            .await
            .access
            .as_ref()
            .map(|t| format!("Bearer {}", t))
    }

    // ─── Auth ───────────────────────────────────────────────────────────────

    pub async fn login(
        &self,
        email: &str,
        password: &str,
        fingerprint: &str,
        hostname: &str,
        os_version: &str,
    ) -> Result<LoginResponse, AppError> {
        let url = format!("{}/api/auth/login", self.base_url);
        let body = serde_json::json!({
            "email": email,
            "password": password,
            "device_fingerprint": fingerprint,
            "hostname": hostname,
            "os_version": os_version,
        });
        let resp = self.http.post(&url).json(&body).send().await?;
        if !resp.status().is_success() {
            return Err(AppError::Auth(friendly_http_error(resp).await));
        }
        let parsed: LoginResponse = resp.json().await?;
        self.set_tokens(parsed.access_token.clone(), parsed.refresh_token.clone())
            .await;
        Ok(parsed)
    }

    pub async fn refresh_tokens(&self) -> Result<(), AppError> {
        let refresh = {
            let t = self.tokens.read().await;
            t.refresh.clone()
        };
        let Some(refresh) = refresh else {
            return Err(AppError::Auth("no refresh token".into()));
        };
        let url = format!("{}/api/auth/refresh", self.base_url);
        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({ "refresh_token": refresh }))
            .send()
            .await?;
        if !resp.status().is_success() {
            self.clear_tokens().await;
            return Err(AppError::Auth("refresh failed — please log in again".into()));
        }
        let parsed: serde_json::Value = resp.json().await?;
        let access = parsed
            .get("access_token")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Auth("malformed refresh response".into()))?
            .to_string();
        let new_refresh = parsed
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .unwrap_or(&refresh)
            .to_string();
        self.set_tokens(access, new_refresh).await;
        Ok(())
    }

    // ─── Authenticated helpers ──────────────────────────────────────────────

    async fn post_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<T, AppError> {
        for attempt in 0..2 {
            let url = format!("{}{}", self.base_url, path);
            let auth = self.auth_header().await.ok_or_else(|| {
                AppError::Auth("not logged in".into())
            })?;
            let resp = self
                .http
                .post(&url)
                .header("Authorization", &auth)
                .json(body)
                .send()
                .await?;
            let status = resp.status();
            if status == StatusCode::UNAUTHORIZED && attempt == 0 {
                self.refresh_tokens().await?;
                continue;
            }
            if !status.is_success() {
                return Err(AppError::Api(friendly_http_error(resp).await));
            }
            return resp.json::<T>().await.map_err(AppError::from);
        }
        Err(AppError::Auth("retry exhausted".into()))
    }

    pub async fn register_encryptor(
        &self,
        password: &str,
        fingerprint: &str,
        hostname: &str,
        os_version: &str,
    ) -> Result<EncryptorRegisterResponse, AppError> {
        self.post_json(
            "/api/admin/encryptors/register",
            &serde_json::json!({
                "password": password,
                "fingerprint": fingerprint,
                "hostname": hostname,
                "os_version": os_version,
            }),
        )
        .await
    }

    pub async fn refresh_master_key(
        &self,
        password: &str,
        encryptor_device_id: &str,
        fingerprint: &str,
    ) -> Result<EncryptorRefreshKeyResponse, AppError> {
        self.post_json(
            "/api/admin/encryptors/refresh-key",
            &serde_json::json!({
                "password": password,
                "encryptor_device_id": encryptor_device_id,
                "fingerprint": fingerprint,
            }),
        )
        .await
    }

    pub async fn ping_encryptor(&self, encryptor_device_id: &str) -> Result<(), AppError> {
        let _: serde_json::Value = self
            .post_json(
                &format!("/api/admin/encryptors/{}/ping", encryptor_device_id),
                &serde_json::json!({}),
            )
            .await?;
        Ok(())
    }

    pub async fn register_encrypted_video(
        &self,
        body: &RegisterEncryptedVideoRequest,
    ) -> Result<RegisterEncryptedVideoResponse, AppError> {
        let value = serde_json::to_value(body)?;
        self.post_json("/api/admin/videos/register-encrypted", &value)
            .await
    }

    pub async fn put_download_urls(
        &self,
        video_id: &str,
        urls: &std::collections::BTreeMap<String, String>,
    ) -> Result<serde_json::Value, AppError> {
        for attempt in 0..2 {
            let url = format!(
                "{}/api/admin/videos/{}/download-urls",
                self.base_url, video_id
            );
            let auth = self.auth_header().await.ok_or_else(|| {
                AppError::Auth("not logged in".into())
            })?;
            let resp = self
                .http
                .put(&url)
                .header("Authorization", &auth)
                .json(&serde_json::json!({ "download_urls": urls }))
                .send()
                .await?;
            let status = resp.status();
            if status == StatusCode::UNAUTHORIZED && attempt == 0 {
                self.refresh_tokens().await?;
                continue;
            }
            if !status.is_success() {
                return Err(AppError::Api(friendly_http_error(resp).await));
            }
            return resp.json().await.map_err(AppError::from);
        }
        Err(AppError::Auth("retry exhausted".into()))
    }
}
