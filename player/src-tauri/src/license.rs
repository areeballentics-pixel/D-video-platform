// license.rs — License validation and management
//
// Handles:
// - Communicating with the license server for activation/validation
// - JWT token storage and refresh
// - 20-day offline grace period
// - Fetching video decryption keys from the server
// - Encrypted key caching for offline playback

use crate::errors::AppError;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

// AES-GCM fallback (used only on non-Windows platforms; Windows uses DPAPI)
#[cfg(not(windows))]
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit};
#[cfg(not(windows))]
use cipher::generic_array::GenericArray;
#[cfg(not(windows))]
use rand::RngCore;
#[cfg(not(windows))]
use sha2::{Digest, Sha256};

/// License status for display in the UI
#[derive(Debug, Clone, Serialize)]
pub enum LicenseStatus {
    Active,
    Expired,
    Revoked,
    NotActivated,
}

/// License information for the frontend
#[derive(Debug, Clone, Serialize)]
pub struct LicenseInfo {
    pub status: LicenseStatus,
    pub last_validated: Option<String>,
    pub offline_days_remaining: Option<u32>,
    pub licensed_videos: Vec<String>,
}

// ─── Server response types ───

#[derive(Debug, Clone, Deserialize, Serialize)]
struct VideoKeyEntry {
    video_id: String,   // hex (32 chars)
    quality: String,    // "480p" / "720p" / "1080p"
    key: String,        // hex (64 chars)
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    user_id: String,
    email: String,
    tenant_id: String,
    /// Per-license key bundle for offline playback. Contains derived keys
    /// only for videos this user is licensed to access.
    /// Optional + defaulted so the player still works against older servers.
    #[serde(default)]
    licensed_video_keys: Vec<VideoKeyEntry>,
}

#[derive(Debug, Deserialize)]
struct VideoKeyResponse {
    key: String,
    // The v1 server response also carries `download_url`, `content_hash`,
    // `file_size`, `is_stream_only`, and `chapters`. We only need `key` here
    // for the offline-grace key lookup; the new download flow in
    // `commands::download_svf` parses those extra fields via `serde_json::Value`
    // directly. serde silently ignores unknown fields, so old servers also work.
}

#[derive(Debug, Deserialize)]
struct ValidateResponse {
    valid: bool,
}

// ─── Persistent auth state (saved to disk) ───

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuthCache {
    access_token: String,
    refresh_token: String,
    user_email: String,
    user_id: String,
    tenant_id: String,
    last_online_validation: DateTime<Utc>,
}

// ─── Offline key cache (encrypted on disk, tied to device fingerprint) ───

/// A single cached decryption key for offline playback.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct KeyCacheEntry {
    key_hex: String,
    cached_at: DateTime<Utc>,
}

/// All cached crypto material. Serialized to JSON, then encrypted with
/// either Windows DPAPI (hardware-backed via TPM when available) or
/// AES-256-GCM (with a key derived from the device fingerprint) on
/// other platforms. The cache is hardware-bound either way.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct KeyCache {
    /// Per-license key bundle delivered by the server on login.
    /// Maps "video_id:quality" → derived key (hex).
    /// This is the primary source for offline playback and contains
    /// ONLY keys for videos this user is licensed to access.
    #[serde(default)]
    licensed_keys: HashMap<String, String>,

    /// Per-video keys cached after a one-off server fetch.
    /// Used for videos that weren't in the licensed bundle (e.g., new
    /// videos added after the user's last login).
    #[serde(default)]
    entries: HashMap<String, KeyCacheEntry>,
}

/// Maximum number of days the player can operate offline before requiring
/// a fresh server validation.
const OFFLINE_GRACE_DAYS: i64 = 20;

/// Manages license authentication, token storage, and key retrieval.
pub struct LicenseManager {
    server_url: String,
    client: reqwest::Client,
    access_token: Option<String>,
    refresh_token: Option<String>,
    user_email: Option<String>,
    user_id: Option<String>,
    tenant_id: Option<String>,
    last_online_validation: Option<DateTime<Utc>>,
}

impl LicenseManager {
    /// Create a new LicenseManager.
    ///
    /// Attempts to load cached auth state from disk. If the cached state
    /// is within the 20-day offline grace period, the user is considered
    /// authenticated without needing to contact the server.
    pub fn new(server_url: &str) -> Self {
        let mut manager = Self {
            server_url: server_url.trim_end_matches('/').to_string(),
            client: reqwest::Client::new(),
            access_token: None,
            refresh_token: None,
            user_email: None,
            user_id: None,
            tenant_id: None,
            last_online_validation: None,
        };

        // Try to restore from cache
        if let Some(cached) = manager.load_auth_cache() {
            let days_since = (Utc::now() - cached.last_online_validation).num_days();

            if days_since <= OFFLINE_GRACE_DAYS {
                log::info!(
                    "Restored auth from cache for {} ({} days since last validation)",
                    cached.user_email,
                    days_since
                );
                manager.access_token = Some(cached.access_token);
                manager.refresh_token = Some(cached.refresh_token);
                manager.user_email = Some(cached.user_email);
                manager.user_id = Some(cached.user_id);
                manager.tenant_id = Some(cached.tenant_id);
                manager.last_online_validation = Some(cached.last_online_validation);
            } else {
                log::warn!(
                    "Cached auth expired ({} days since last validation, grace period is {} days)",
                    days_since,
                    OFFLINE_GRACE_DAYS
                );
                // Clear the stale cache file
                let _ = manager.clear_auth_cache();
            }
        }

        manager
    }

    // ─── Authentication ───

    /// Log in with email and password.
    ///
    /// Sends credentials + device fingerprint to the server, receives
    /// JWT tokens, and caches them to disk for offline use.
    pub async fn login(
        &mut self,
        email: &str,
        password: &str,
        fingerprint: &str,
    ) -> Result<(), AppError> {
        let url = format!("{}/api/auth/login", self.server_url);

        // Include hostname + OS so the tenant admin can recognise which
        // physical machine a student is on (the raw fingerprint alone is
        // opaque; "DESKTOP-LAKSH / windows" is human-readable).
        let hostname = hostname::get()
            .ok()
            .and_then(|h| h.into_string().ok())
            .unwrap_or_default();
        let os_version = std::env::consts::OS.to_string();

        let body = serde_json::json!({
            "email": email,
            "password": password,
            "device_fingerprint": fingerprint,
            "hostname": hostname,
            "os_version": os_version,
        });

        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await?;

        // Fresh-login 401 = bad credentials, NOT an expired session.
        // Let handle_login_status emit a UX-accurate error.
        Self::handle_login_status(&response, "Invalid email or password")?;

        let token_resp: TokenResponse = response.json().await?;
        self.store_tokens(token_resp, fingerprint);

        Ok(())
    }

    /// Log in with a license key (no email/password required).
    pub async fn login_with_key(
        &mut self,
        license_key: &str,
        fingerprint: &str,
    ) -> Result<(), AppError> {
        let url = format!("{}/api/auth/login-key", self.server_url);

        let hostname = hostname::get()
            .ok()
            .and_then(|h| h.into_string().ok())
            .unwrap_or_default();
        let os_version = std::env::consts::OS.to_string();

        let body = serde_json::json!({
            "license_key": license_key,
            "device_fingerprint": fingerprint,
            "hostname": hostname,
            "os_version": os_version,
        });

        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await?;

        Self::handle_login_status(&response, "Invalid license key")?;

        let token_resp: TokenResponse = response.json().await?;
        self.store_tokens(token_resp, fingerprint);

        Ok(())
    }

    /// Log out and clear all stored tokens.
    pub async fn logout(&mut self) -> Result<(), AppError> {
        // Best-effort server notification
        if let Some(token) = &self.access_token {
            let url = format!("{}/api/auth/logout", self.server_url);
            let _ = self
                .client
                .post(&url)
                .bearer_auth(token)
                .send()
                .await;
        }

        self.access_token = None;
        self.refresh_token = None;
        self.user_email = None;
        self.user_id = None;
        self.tenant_id = None;
        self.last_online_validation = None;

        let _ = self.clear_auth_cache();
        let _ = self.clear_key_cache();

        log::info!("Logged out and cleared all caches");
        Ok(())
    }

    // ─── License & Key Operations ───

    /// Fetch the decryption key for a video chunk.
    ///
    /// Takes the raw fields from the `.svf` header. Tries in order:
    ///
    /// 1. **Licensed bundle lookup** (offline-capable): if the video is in
    ///    the bundle delivered at login, return its key directly. This is
    ///    the normal path for offline playback. The tenant master key is
    ///    NEVER on the device — only derived per-video keys for content
    ///    this user is licensed to access.
    ///
    /// 2. **Server fetch**: if the video isn't in the bundle (e.g., added
    ///    after the user's last login), contact the server.
    ///
    /// 3. **Per-video offline cache**: if the server is unreachable AND
    ///    this specific video's key was previously fetched and cached,
    ///    use that (subject to the 20-day grace period).
    pub async fn fetch_video_key(
        &self,
        video_id: &[u8; 16],
        tenant_id: &[u8; 16],
        salt: &[u8; 32],
        quality: u16,
        fingerprint: &str,
    ) -> Result<String, AppError> {
        let _ = (tenant_id, salt); // reserved for future use; not needed for bundle lookup

        let video_id_hex = hex::encode(video_id);
        let quality_str = Self::quality_to_str(quality)?;
        let cache_key = format!("{}:{}", video_id_hex, quality_str);

        // ─── Path 1: licensed bundle lookup (the offline-first path) ───
        if let Some(key_hex) = self.lookup_licensed_key(&cache_key, fingerprint) {
            // Enforce the offline grace period — gives the admin a way to
            // revoke access by waiting it out (or rotating the tenant key).
            if self.within_offline_grace_period() {
                log::info!("Using licensed bundle key for {}", cache_key);
                return Ok(key_hex);
            }
            log::warn!(
                "Licensed key found but offline grace period expired — \
                 requiring online re-validation"
            );
            // Fall through to server path
        }

        // ─── Path 2: fetch from server ───
        let token = self
            .access_token
            .as_ref()
            .ok_or_else(|| AppError::License("Not authenticated".to_string()))?;

        let url = format!("{}/api/videos/key", self.server_url);

        let body = serde_json::json!({
            "video_id": video_id_hex,
            "quality": quality_str,
            "device_fingerprint": fingerprint,
        });

        match self
            .client
            .post(&url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
        {
            Ok(response) => {
                if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                    return Err(AppError::License(
                        "Session expired. Please log in again.".to_string(),
                    ));
                }

                Self::handle_error_status(&response)?;

                let key_resp: VideoKeyResponse = response.json().await?;

                // Cache the per-video key for future offline access
                if let Err(e) = self.cache_video_key(
                    &video_id_hex, quality_str, &key_resp.key, fingerprint,
                ) {
                    log::warn!("Failed to cache video key: {}", e);
                }

                Ok(key_resp.key)
            }
            Err(e) => {
                // ─── Path 3: offline per-video cache (last resort) ───
                log::warn!("Cannot reach license server: {}. Trying offline cache.", e);
                self.get_cached_video_key(&video_id_hex, quality_str, fingerprint)
            }
        }
    }

    /// Look up a key in the licensed bundle (decrypts the cache file).
    fn lookup_licensed_key(&self, cache_key: &str, fingerprint: &str) -> Option<String> {
        self.load_key_cache(fingerprint)
            .ok()
            .and_then(|cache| cache.licensed_keys.get(cache_key).cloned())
    }

    /// Returns true if the last online validation is within the grace period.
    fn within_offline_grace_period(&self) -> bool {
        match self.last_online_validation {
            Some(last) => (Utc::now() - last).num_days() <= OFFLINE_GRACE_DAYS,
            None => false,
        }
    }

    /// Map the numeric quality from the .svf header to the string form
    /// used in the cache and server API. The encryptor uses 65535 ("original")
    /// when an input doesn't match a standard bucket — pendrives, scratch
    /// recordings, etc. — so the player must accept it as a valid label too.
    fn quality_to_str(quality: u16) -> Result<&'static str, AppError> {
        match quality {
            0 => Ok("480p"),
            1 => Ok("720p"),
            2 => Ok("1080p"),
            65535 => Ok("original"),
            q => Err(AppError::License(format!("Unknown quality: {}", q))),
        }
    }

    /// Validate the license for a specific video against the server.
    ///
    /// Updates `last_online_validation` on success so the offline grace
    /// period timer resets.
    pub async fn validate_license(
        &mut self,
        video_id: &str,
        fingerprint: &str,
    ) -> Result<bool, AppError> {
        let token = self
            .access_token
            .as_ref()
            .ok_or_else(|| AppError::License("Not authenticated".to_string()))?
            .clone();

        let url = format!("{}/api/licenses/validate", self.server_url);

        let body = serde_json::json!({
            "video_id": video_id,
            "device_fingerprint": fingerprint,
        });

        let response = self
            .client
            .post(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AppError::License(
                "Session expired. Please log in again.".to_string(),
            ));
        }

        Self::handle_error_status(&response)?;

        let validate_resp: ValidateResponse = response.json().await?;

        if validate_resp.valid {
            self.last_online_validation = Some(Utc::now());
            let _ = self.save_auth_cache();
        }

        Ok(validate_resp.valid)
    }

    // ─── State Queries ───

    /// Returns true if the manager has an active access token.
    pub fn is_authenticated(&self) -> bool {
        self.access_token.is_some()
    }

    /// Returns the authenticated user's email, if any.
    pub fn user_email(&self) -> Option<&str> {
        self.user_email.as_deref()
    }

    /// API server base URL (no trailing slash).
    pub fn server_url(&self) -> &str {
        &self.server_url
    }

    /// Current bearer token, if logged in.
    pub fn access_token(&self) -> Option<&str> {
        self.access_token.as_deref()
    }

    /// Build a LicenseInfo snapshot for the frontend.
    pub fn license_info(&self) -> LicenseInfo {
        if !self.is_authenticated() {
            return LicenseInfo {
                status: LicenseStatus::NotActivated,
                last_validated: None,
                offline_days_remaining: None,
                licensed_videos: vec![],
            };
        }

        let offline_days_remaining = self.last_online_validation.map(|last| {
            let days_since = (Utc::now() - last).num_days();
            (OFFLINE_GRACE_DAYS - days_since).max(0) as u32
        });

        LicenseInfo {
            status: LicenseStatus::Active,
            last_validated: self
                .last_online_validation
                .map(|dt| dt.to_rfc3339()),
            offline_days_remaining,
            licensed_videos: vec![],
        }
    }

    // ─── Private Helpers ───

    /// Store tokens from a successful login response and persist to disk.
    ///
    /// Replaces the licensed key bundle with whatever the server sent.
    /// Per-video cache entries from previous sessions are preserved
    /// (they're a fallback for videos not in the bundle).
    fn store_tokens(&mut self, resp: TokenResponse, fingerprint: &str) {
        self.access_token = Some(resp.access_token);
        self.refresh_token = Some(resp.refresh_token);
        self.user_email = Some(resp.email);
        self.user_id = Some(resp.user_id);
        self.tenant_id = Some(resp.tenant_id);
        self.last_online_validation = Some(Utc::now());

        if let Err(e) = self.save_auth_cache() {
            log::warn!("Failed to save auth cache: {}", e);
        }

        // Replace the licensed key bundle with the latest from the server.
        // Preserve per-video `entries` so cached keys for videos outside
        // the bundle still work offline.
        let mut cache = self.load_key_cache(fingerprint).unwrap_or_default();
        cache.licensed_keys.clear();
        for entry in resp.licensed_video_keys {
            let cache_key = format!("{}:{}", entry.video_id, entry.quality);
            cache.licensed_keys.insert(cache_key, entry.key);
        }

        let bundle_size = cache.licensed_keys.len();
        if let Err(e) = self.save_key_cache(&cache, fingerprint) {
            log::warn!("Failed to save licensed key bundle: {}", e);
        } else {
            log::info!(
                "Cached {} licensed video keys — offline playback enabled",
                bundle_size
            );
        }
    }

    /// Check HTTP response status and map to AppError for general API calls.
    /// Treats 401 as "session expired" (the token was rejected).
    fn handle_error_status(response: &reqwest::Response) -> Result<(), AppError> {
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }

        match status {
            reqwest::StatusCode::UNAUTHORIZED => Err(AppError::License(
                "Session expired. Please log in again.".to_string(),
            )),
            reqwest::StatusCode::FORBIDDEN => Err(AppError::License(
                "Access denied. Your license may have been revoked.".to_string(),
            )),
            reqwest::StatusCode::NOT_FOUND => Err(AppError::License(
                "This video is not registered on the server — it may have been removed, or \
                 this file is an older copy whose video was re-encrypted with a new ID. \
                 Ask your institute for the current file.".to_string(),
            )),
            s if s.is_server_error() => Err(AppError::License("Server error".to_string())),
            _ => Err(AppError::License(format!(
                "Request failed with status {}",
                status
            ))),
        }
    }

    /// Variant of handle_error_status for the login endpoints. On a fresh
    /// login attempt, 401 means "bad credentials" — NOT "session expired" —
    /// so the caller supplies the right message for the user to see.
    fn handle_login_status(
        response: &reqwest::Response,
        unauthorized_message: &str,
    ) -> Result<(), AppError> {
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }

        match status {
            reqwest::StatusCode::UNAUTHORIZED => {
                Err(AppError::License(unauthorized_message.to_string()))
            }
            reqwest::StatusCode::FORBIDDEN => Err(AppError::License(
                "Account suspended or access denied.".to_string(),
            )),
            reqwest::StatusCode::TOO_MANY_REQUESTS => Err(AppError::License(
                "Too many device changes recently. Please try again later.".to_string(),
            )),
            s if s.is_server_error() => Err(AppError::License("Server error".to_string())),
            _ => Err(AppError::License(format!(
                "Login failed with status {}",
                status
            ))),
        }
    }

    // ─── Disk Persistence ───

    /// Path to the auth cache JSON file.
    fn auth_cache_path(&self) -> Option<PathBuf> {
        directories::ProjectDirs::from("com", "secure-video-player", "secure-video-player")
            .map(|dirs| dirs.data_dir().join("auth.json"))
    }

    /// Save current auth state to disk (plaintext JSON for Sprint 5).
    fn save_auth_cache(&self) -> Result<(), AppError> {
        let path = self
            .auth_cache_path()
            .ok_or_else(|| AppError::Device("Cannot determine app data directory".to_string()))?;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let cache = AuthCache {
            access_token: self
                .access_token
                .clone()
                .unwrap_or_default(),
            refresh_token: self
                .refresh_token
                .clone()
                .unwrap_or_default(),
            user_email: self
                .user_email
                .clone()
                .unwrap_or_default(),
            user_id: self
                .user_id
                .clone()
                .unwrap_or_default(),
            tenant_id: self
                .tenant_id
                .clone()
                .unwrap_or_default(),
            last_online_validation: self
                .last_online_validation
                .unwrap_or_else(Utc::now),
        };

        let json = serde_json::to_string_pretty(&cache)?;
        fs::write(&path, json)?;

        log::info!("Auth cache saved to {:?}", path);
        Ok(())
    }

    /// Load auth state from disk.
    fn load_auth_cache(&self) -> Option<AuthCache> {
        let path = self.auth_cache_path()?;
        let data = fs::read_to_string(&path).ok()?;
        serde_json::from_str(&data).ok()
    }

    /// Delete the auth cache file.
    fn clear_auth_cache(&self) -> Result<(), AppError> {
        if let Some(path) = self.auth_cache_path() {
            if path.exists() {
                fs::remove_file(&path)?;
            }
        }
        Ok(())
    }

    // ─── Offline Key Cache ───
    //
    // Video decryption keys are cached to an encrypted file on disk so
    // that videos can be played offline within the 20-day grace period.
    //
    // Security model:
    // - The cache file (key_cache.bin) is encrypted with AES-256-GCM
    // - The encryption key is derived from the device fingerprint via SHA-256
    // - This makes the cache hardware-bound: copying it to another machine fails
    // - On logout, the cache is deleted
    // - After the grace period expires, cached keys are rejected

    /// Derive an AES-256 encryption key from the device fingerprint.
    /// Only used by the non-Windows AES-GCM fallback path.
    #[cfg(not(windows))]
    fn derive_cache_encryption_key(fingerprint: &str) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"svp-key-cache-v1:");
        hasher.update(fingerprint.as_bytes());
        hasher.finalize().into()
    }

    /// Encrypt data so only this user, on this hardware, can decrypt it.
    ///
    /// On Windows: uses DPAPI (`CryptProtectData`). The encryption key is
    /// managed by the OS, bound to the current Windows user account, and
    /// backed by the TPM chip when available. Even with full filesystem
    /// access, an attacker can't decrypt the cache without running code
    /// AS the user ON the same physical machine.
    ///
    /// On other platforms: falls back to AES-256-GCM with a key derived
    /// from the device fingerprint.
    ///
    /// In both cases the device fingerprint is mixed in (as DPAPI entropy
    /// or as the AES key) so even another Windows user account on the
    /// same machine can't decrypt the cache.
    fn encrypt_cache_data(plaintext: &[u8], fingerprint: &str) -> Result<Vec<u8>, AppError> {
        #[cfg(windows)]
        {
            Self::dpapi_protect(plaintext, fingerprint.as_bytes())
        }

        #[cfg(not(windows))]
        {
            Self::aes_gcm_encrypt(plaintext, fingerprint)
        }
    }

    /// Decrypt data that was encrypted with `encrypt_cache_data`.
    fn decrypt_cache_data(data: &[u8], fingerprint: &str) -> Result<Vec<u8>, AppError> {
        #[cfg(windows)]
        {
            Self::dpapi_unprotect(data, fingerprint.as_bytes())
        }

        #[cfg(not(windows))]
        {
            Self::aes_gcm_decrypt(data, fingerprint)
        }
    }

    /// Windows DPAPI encryption (CryptProtectData).
    ///
    /// Binds the data to:
    /// - The current Windows user (different user → can't decrypt)
    /// - The current physical machine (different hardware → can't decrypt)
    /// - The provided entropy (device fingerprint → another binding layer)
    /// - The TPM chip when present (key never extractable from hardware)
    #[cfg(windows)]
    fn dpapi_protect(plaintext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, AppError> {
        use windows::Win32::Foundation::{HLOCAL, LocalFree};
        use windows::Win32::Security::Cryptography::{
            CryptProtectData, CRYPT_INTEGER_BLOB,
        };

        let input = CRYPT_INTEGER_BLOB {
            cbData: plaintext.len() as u32,
            pbData: plaintext.as_ptr() as *mut u8,
        };

        let entropy_blob = CRYPT_INTEGER_BLOB {
            cbData: entropy.len() as u32,
            pbData: entropy.as_ptr() as *mut u8,
        };

        let mut output = CRYPT_INTEGER_BLOB::default();

        unsafe {
            CryptProtectData(
                &input,
                None,
                Some(&entropy_blob),
                None,
                None,
                0, // dwFlags=0 → bound to current user (most secure)
                &mut output,
            )
            .map_err(|e| AppError::Crypto(format!("DPAPI encryption failed: {}", e)))?;
        }

        // Copy ciphertext out of DPAPI's LocalAlloc'd buffer, then free it.
        let result = unsafe {
            std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
        };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(output.pbData as _)));
        }
        Ok(result)
    }

    /// Windows DPAPI decryption (CryptUnprotectData).
    #[cfg(windows)]
    fn dpapi_unprotect(ciphertext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, AppError> {
        use windows::Win32::Foundation::{HLOCAL, LocalFree};
        use windows::Win32::Security::Cryptography::{
            CryptUnprotectData, CRYPT_INTEGER_BLOB,
        };

        let input = CRYPT_INTEGER_BLOB {
            cbData: ciphertext.len() as u32,
            pbData: ciphertext.as_ptr() as *mut u8,
        };

        let entropy_blob = CRYPT_INTEGER_BLOB {
            cbData: entropy.len() as u32,
            pbData: entropy.as_ptr() as *mut u8,
        };

        let mut output = CRYPT_INTEGER_BLOB::default();

        unsafe {
            CryptUnprotectData(
                &input,
                None,
                Some(&entropy_blob),
                None,
                None,
                0,
                &mut output,
            )
            .map_err(|_| {
                AppError::Crypto(
                    "DPAPI decryption failed — cache may be from a different user, \
                     machine, or hardware fingerprint".to_string(),
                )
            })?;
        }

        let result = unsafe {
            std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
        };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(output.pbData as _)));
        }
        Ok(result)
    }

    /// AES-256-GCM fallback for non-Windows platforms.
    /// Output: nonce (12 bytes) || ciphertext || GCM tag (16 bytes)
    #[cfg(not(windows))]
    fn aes_gcm_encrypt(plaintext: &[u8], fingerprint: &str) -> Result<Vec<u8>, AppError> {
        let key_bytes = Self::derive_cache_encryption_key(fingerprint);
        let cipher = Aes256Gcm::new_from_slice(&key_bytes)
            .map_err(|_| AppError::Crypto("Cache cipher init failed".to_string()))?;

        let mut nonce_bytes = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = GenericArray::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|_| AppError::Crypto("Key cache encryption failed".to_string()))?;

        let mut result = Vec::with_capacity(12 + ciphertext.len());
        result.extend_from_slice(&nonce_bytes);
        result.extend_from_slice(&ciphertext);
        Ok(result)
    }

    #[cfg(not(windows))]
    fn aes_gcm_decrypt(data: &[u8], fingerprint: &str) -> Result<Vec<u8>, AppError> {
        if data.len() < 28 {
            return Err(AppError::Crypto("Key cache file too short".to_string()));
        }

        let key_bytes = Self::derive_cache_encryption_key(fingerprint);
        let cipher = Aes256Gcm::new_from_slice(&key_bytes)
            .map_err(|_| AppError::Crypto("Cache cipher init failed".to_string()))?;

        let nonce = GenericArray::from_slice(&data[..12]);

        cipher
            .decrypt(nonce, &data[12..])
            .map_err(|_| AppError::Crypto(
                "Key cache decryption failed — device fingerprint may have changed".to_string(),
            ))
    }

    /// Path to the encrypted key cache file.
    fn key_cache_path(&self) -> Option<PathBuf> {
        directories::ProjectDirs::from("com", "secure-video-player", "secure-video-player")
            .map(|dirs| dirs.data_dir().join("key_cache.bin"))
    }

    /// Serialize a KeyCache, encrypt it, and write it to disk.
    fn save_key_cache(&self, cache: &KeyCache, fingerprint: &str) -> Result<(), AppError> {
        let path = self
            .key_cache_path()
            .ok_or_else(|| AppError::Device("Cannot determine app data directory".to_string()))?;

        let json = serde_json::to_vec(cache)?;
        let encrypted = Self::encrypt_cache_data(&json, fingerprint)?;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        fs::write(&path, encrypted)?;
        Ok(())
    }

    /// Save a per-video key to the encrypted cache (fallback for when a
    /// video isn't in the licensed bundle, e.g. added after last login).
    fn cache_video_key(
        &self,
        video_id: &str,
        quality: &str,
        key_hex: &str,
        fingerprint: &str,
    ) -> Result<(), AppError> {
        let mut cache = self.load_key_cache(fingerprint).unwrap_or_default();

        let cache_key = format!("{}:{}", video_id, quality);
        cache.entries.insert(
            cache_key,
            KeyCacheEntry {
                key_hex: key_hex.to_string(),
                cached_at: Utc::now(),
            },
        );

        self.save_key_cache(&cache, fingerprint)?;
        log::info!(
            "Cached per-video key ({} entries total)",
            cache.entries.len()
        );
        Ok(())
    }

    /// Load the key cache from the encrypted file on disk.
    fn load_key_cache(&self, fingerprint: &str) -> Result<KeyCache, AppError> {
        let path = self
            .key_cache_path()
            .ok_or_else(|| AppError::Device("Cannot determine app data directory".to_string()))?;

        let encrypted = fs::read(&path).map_err(|e| {
            AppError::Crypto(format!("Cannot read key cache: {}", e))
        })?;

        let decrypted = Self::decrypt_cache_data(&encrypted, fingerprint)?;

        serde_json::from_slice(&decrypted).map_err(|e| {
            AppError::Crypto(format!("Invalid key cache format: {}", e))
        })
    }

    /// Retrieve a cached video key for offline playback.
    ///
    /// Checks the offline grace period first — if expired, rejects the request
    /// even if a cached key exists. This ensures the admin can revoke access
    /// by waiting out the grace period.
    fn get_cached_video_key(
        &self,
        video_id: &str,
        quality: &str,
        fingerprint: &str,
    ) -> Result<String, AppError> {
        // Enforce the offline grace period
        let last = self.last_online_validation.ok_or_else(|| {
            AppError::License(
                "No previous online validation. Please connect to the internet and log in."
                    .to_string(),
            )
        })?;

        let days_since = (Utc::now() - last).num_days();
        if days_since > OFFLINE_GRACE_DAYS {
            return Err(AppError::License(format!(
                "Offline grace period expired ({} days since last online validation, \
                 max {} days). Please connect to the internet to continue.",
                days_since, OFFLINE_GRACE_DAYS
            )));
        }

        // Load cache and look up the key
        let cache = self.load_key_cache(fingerprint).map_err(|_| {
            AppError::License(
                "No offline key cache found. Please play this video while \
                 online at least once."
                    .to_string(),
            )
        })?;

        let cache_key = format!("{}:{}", video_id, quality);
        cache
            .entries
            .get(&cache_key)
            .map(|entry| {
                log::info!(
                    "Offline playback: using cached key for {} (cached {}, {} days offline)",
                    cache_key,
                    entry.cached_at.format("%Y-%m-%d"),
                    days_since
                );
                entry.key_hex.clone()
            })
            .ok_or_else(|| {
                AppError::License(
                    "This video hasn't been played online yet. Please connect \
                     to the internet for the first playback."
                        .to_string(),
                )
            })
    }

    /// Delete the encrypted key cache file (called on logout).
    fn clear_key_cache(&self) -> Result<(), AppError> {
        if let Some(path) = self.key_cache_path() {
            if path.exists() {
                fs::remove_file(&path)?;
                log::info!("Key cache cleared");
            }
        }
        Ok(())
    }
}

// ─── Live access re-validation during playback (QA SP-009 / SP-014) ───
//
// Access is normally only checked at playback start. This background monitor
// re-validates the license against the server every couple of minutes WHILE a
// video plays, and tells the frontend to stop if access was revoked or the
// video deleted. When the device is offline it stays silent — the documented
// 20-day offline grace still applies, so legitimate offline users aren't cut off.

/// Handle for the background re-validation task; dropping it stops the task.
pub struct RevalidationMonitor {
    stop_tx: tokio::sync::watch::Sender<bool>,
}

impl RevalidationMonitor {
    pub fn start(
        app_handle: tauri::AppHandle,
        license_manager: std::sync::Arc<tokio::sync::Mutex<LicenseManager>>,
        video_id: String,
        fingerprint: String,
    ) -> Self {
        let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);

        tokio::spawn(async move {
            use tauri::Emitter;
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(120));
            // Do NOT consume the first tick — validate IMMEDIATELY at playback
            // start. A student playing from the cached offline bundle never
            // contacts the server otherwise, so a revoked enrollment or a
            // SUSPENDED tenant would only take effect 120s later. Validating now
            // cuts playback off within ~1s when online. Offline, the check
            // errors and we stay silent, preserving the 20-day offline grace.

            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        let result = {
                            let mut lm = license_manager.lock().await;
                            lm.validate_license(&video_id, &fingerprint).await
                        };
                        match result {
                            Ok(true) => {}
                            Ok(false) => {
                                let _ = app_handle.emit(
                                    "access-revoked",
                                    "Your access to this video has been revoked.".to_string(),
                                );
                                break;
                            }
                            Err(AppError::License(msg)) => {
                                // Stop only on genuine access loss. Deliberately do
                                // NOT match "expired": a 401 yields "Session expired"
                                // because the 2h access token lapsed (there is no
                                // refresh path) — that must NOT stop playback within
                                // the offline grace. Real revocation/deletion arrives
                                // as Ok(false) above, or as 403 "Access denied …
                                // revoked" (caught by denied/revoke).
                                let m = msg.to_lowercase();
                                if m.contains("revoke")
                                    || m.contains("denied")
                                    || m.contains("suspend")
                                {
                                    let _ = app_handle.emit("access-revoked", msg);
                                    break;
                                }
                            }
                            Err(_) => { /* offline / transient — rely on offline grace */ }
                        }
                    }
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            break;
                        }
                    }
                }
            }
            log::info!("Revalidation monitor stopped");
        });

        RevalidationMonitor { stop_tx }
    }

    pub fn stop(&self) {
        let _ = self.stop_tx.send(true);
    }
}

impl Drop for RevalidationMonitor {
    fn drop(&mut self) {
        self.stop();
    }
}
