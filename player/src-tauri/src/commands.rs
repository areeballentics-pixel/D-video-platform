// commands.rs — Tauri IPC command handlers
//
// These functions are callable from React via:
//   import { invoke } from "@tauri-apps/api/core";
//   const result = await invoke("command_name", { arg1: "value" });

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{Manager, State};
use tokio::sync::Mutex;

use svf_core::{DeviceInfo, SecureKey, SvfFile, SvfInfo};

use crate::errors::AppError;
use crate::license::{LicenseManager, RevalidationMonitor};
use crate::player::{prepare_playback, PlaybackInfo, PlaybackSlot};
use crate::security::SecurityMonitor;
use crate::watermark::WatermarkRotator;

/// Application-wide state, managed by Tauri.
pub struct AppState {
    /// Active playback served by the `stream` custom-protocol handler.
    /// std Mutex because the protocol handler is synchronous.
    pub active_playback: PlaybackSlot,
    pub library_path: Arc<Mutex<Option<String>>>,
    pub license_manager: Arc<Mutex<LicenseManager>>,
    pub security_monitor: Arc<Mutex<Option<SecurityMonitor>>>,
    pub watermark_rotator: Arc<Mutex<Option<WatermarkRotator>>>,
    pub revalidation_monitor: Arc<Mutex<Option<RevalidationMonitor>>>,
}

/// License server URL, baked in at compile time via the `SVP_SERVER_URL`
/// environment variable. Falls back to the local dev server when unset.
///
/// For production builds:
///   set SVP_SERVER_URL=https://api.yourplatform.com
///   cargo tauri build
const SERVER_URL: &str = match option_env!("SVP_SERVER_URL") {
    Some(url) => url,
    None => "http://127.0.0.1:8000",
};

impl AppState {
    pub fn new() -> Self {
        Self {
            active_playback: Arc::new(std::sync::Mutex::new(None)),
            library_path: Arc::new(Mutex::new(None)),
            license_manager: Arc::new(Mutex::new(LicenseManager::new(SERVER_URL))),
            security_monitor: Arc::new(Mutex::new(None)),
            watermark_rotator: Arc::new(Mutex::new(None)),
            revalidation_monitor: Arc::new(Mutex::new(None)),
        }
    }
}

/// Auth status returned to the frontend
#[derive(Debug, Clone, Serialize)]
pub struct AuthStatus {
    pub authenticated: bool,
    pub email: Option<String>,
}

// ─── Device Commands ───

#[tauri::command]
pub fn get_device_info() -> Result<DeviceInfo, AppError> {
    Ok(svf_core::collect_fingerprint()?)
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}


// ─── v1: Download .svf from institute-hosted URL ────────────────────────────

#[derive(Debug, serde::Deserialize)]
pub struct DownloadInput {
    pub video_id: String,
    pub quality: String,
    /// Where to save the .svf — usually "<library_dir>/{video_id}_{quality}.svf"
    pub output_path: String,
}


#[derive(Debug, serde::Serialize)]
pub struct DownloadResult {
    pub output_path: String,
    pub bytes_written: u64,
}


/// Resolve the per-quality download URL via /api/videos/key, then stream the
/// .svf to disk. The server-returned `content_hash` is the hash of the
/// pre-encryption original — it can't be verified mid-download, but the
/// existing per-chunk hashes in the .svf header catch tampering at playback.
#[tauri::command]
pub async fn download_svf(
    input: DownloadInput,
    state: State<'_, AppState>,
) -> Result<DownloadResult, AppError> {
    use std::io::Write;

    let device = svf_core::collect_fingerprint()?;
    let lm = state.license_manager.lock().await;
    let server_url = lm.server_url().to_string();
    let token = lm
        .access_token()
        .ok_or_else(|| AppError::License("Not authenticated".into()))?
        .to_string();
    drop(lm);

    let client = reqwest::Client::new();
    let key_url = format!("{}/api/videos/key", server_url);
    let key_resp: serde_json::Value = client
        .post(&key_url)
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "video_id": input.video_id,
            "quality": input.quality,
            "device_fingerprint": device.fingerprint,
        }))
        .send()
        .await
        .map_err(|e| AppError::Network(e))?
        .error_for_status()
        .map_err(|e| AppError::Network(e))?
        .json()
        .await
        .map_err(|e| AppError::Network(e))?;

    // If a download URL is published, fetch from there. Otherwise the file
    // is expected to be sideloaded (USB, pendrive, manual copy) into the
    // local library. We return a special-cased error string the React side
    // recognizes and turns into a "place this file in your library folder"
    // hint instead of a generic error.
    let download_url = match key_resp.get("download_url").and_then(|v| v.as_str()) {
        Some(url) if !url.is_empty() => url,
        _ => {
            return Err(AppError::License(format!(
                "no_download_url:{}",
                input.output_path
            )));
        }
    };

    // Stream-download to avoid loading the whole .svf into memory.
    let mut resp = client
        .get(download_url)
        .send()
        .await
        .map_err(|e| AppError::Network(e))?
        .error_for_status()
        .map_err(|e| AppError::Network(e))?;

    if let Some(parent) = std::path::Path::new(&input.output_path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::File::create(&input.output_path)?;
    let mut bytes_written: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| AppError::Network(e))? {
        file.write_all(&chunk)?;
        bytes_written += chunk.len() as u64;
    }
    file.sync_all()?;

    // Sanity-check the file parses as a valid .svf — catches "Drive served
    // a 404 HTML page disguised as a 200" type failures cleanly here rather
    // than at playback time when the user is staring at a spinner.
    let _ = svf_core::SvfFile::open(&input.output_path)
        .map_err(|e| AppError::License(format!(
            "Downloaded file is not a valid .svf: {}", e
        )))?;

    Ok(DownloadResult {
        output_path: input.output_path,
        bytes_written,
    })
}


// ─── v1: Watch-event heartbeats ────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
pub struct HeartbeatInput {
    pub video_id: String,
    pub position_ms: u64,
    pub watched_delta_ms: u32,
    pub course_id: Option<String>,
}


/// Send a single heartbeat to /api/watch-events/heartbeat. The frontend ticks
/// this every 15-30 seconds while playback is active.
#[tauri::command]
pub async fn report_watch_heartbeat(
    input: HeartbeatInput,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let lm = state.license_manager.lock().await;
    let server_url = lm.server_url().to_string();
    let token = lm
        .access_token()
        .ok_or_else(|| AppError::License("Not authenticated".into()))?
        .to_string();
    drop(lm);

    let url = format!("{}/api/watch-events/heartbeat", server_url);
    let _ = reqwest::Client::new()
        .post(&url)
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "video_id": input.video_id,
            "position_ms": input.position_ms,
            "watched_delta_ms": input.watched_delta_ms,
            "course_id": input.course_id,
        }))
        .send()
        .await
        .map_err(|e| AppError::Network(e))?;
    // Best-effort: heartbeat failures don't fail playback.
    Ok(())
}

// ─── Auth Commands ───

/// Check if the user is already authenticated (from cached tokens)
#[tauri::command]
pub async fn check_auth(state: State<'_, AppState>) -> Result<AuthStatus, AppError> {
    let lm = state.license_manager.lock().await;
    Ok(AuthStatus {
        authenticated: lm.is_authenticated(),
        email: lm.user_email().map(|s| s.to_string()),
    })
}

/// Login with email + password
#[tauri::command]
pub async fn login(
    email: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<AuthStatus, AppError> {
    let device = svf_core::collect_fingerprint()?;
    let mut lm = state.license_manager.lock().await;
    lm.login(&email, &password, &device.fingerprint).await?;

    Ok(AuthStatus {
        authenticated: true,
        email: lm.user_email().map(|s| s.to_string()),
    })
}

/// Login with license key
#[tauri::command]
pub async fn login_with_key(
    license_key: String,
    state: State<'_, AppState>,
) -> Result<AuthStatus, AppError> {
    let device = svf_core::collect_fingerprint()?;
    let mut lm = state.license_manager.lock().await;
    lm.login_with_key(&license_key, &device.fingerprint).await?;

    Ok(AuthStatus {
        authenticated: true,
        email: lm.user_email().map(|s| s.to_string()),
    })
}

/// Logout and clear all tokens
#[tauri::command]
pub async fn logout(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    // Stop any active playback first
    stop_all_playback_resources(&state, &app_handle).await;

    let mut lm = state.license_manager.lock().await;
    lm.logout().await?;
    Ok(())
}

// ─── Library Commands ───

#[tauri::command]
pub async fn scan_library(
    folder: String,
    state: State<'_, AppState>,
) -> Result<Vec<SvfInfo>, AppError> {
    let folder_path = PathBuf::from(&folder);

    if !folder_path.exists() || !folder_path.is_dir() {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("Folder not found: {}", folder),
        )));
    }

    let mut videos = Vec::new();

    let entries = std::fs::read_dir(&folder_path).map_err(|e| {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("Cannot read folder: {}", e),
        ))
    })?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("svf") {
            match SvfFile::open(&path) {
                Ok(svf) => {
                    let mut info = svf.info();
                    info.video_id = path.to_string_lossy().to_string();
                    videos.push(info);
                }
                Err(e) => {
                    log::warn!("Skipping invalid .svf file {:?}: {}", path, e);
                }
            }
        }
    }

    *state.library_path.lock().await = Some(folder);
    Ok(videos)
}

// ─── Playback Commands ───

/// Start playback with full security protections.
///
/// 1. Fetches decryption key from license server
/// 2. Enables screen capture protection (SetWindowDisplayAffinity)
/// 3. Starts security monitor (scans for recorders/RDP/VM/debugger every 30s)
/// 4. Starts watermark rotation (random position every 5-10s)
/// 5. Spawns HTTP server for decrypted video streaming
#[tauri::command]
pub async fn start_playback(
    video_path: String,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PlaybackInfo, AppError> {
    let svf_path = PathBuf::from(&video_path);

    if !svf_path.exists() {
        return Err(AppError::SvfParse(format!("File not found: {}", video_path)));
    }

    // Stop any existing playback first
    stop_all_playback_resources(&state, &app_handle).await;

    // Read the .svf header — it contains everything needed for local key derivation
    let svf = SvfFile::open(&svf_path)?;

    // Get the device fingerprint
    let device = svf_core::collect_fingerprint()?;

    // Fetch the decryption key. When the tenant master key is cached, this
    // derives the per-video key locally (fully offline). Otherwise it falls
    // back to a server call or per-video offline cache.
    let key_hex = {
        let lm = state.license_manager.lock().await;
        lm.fetch_video_key(
            &svf.header.video_id,
            &svf.header.tenant_id,
            &svf.header.encryption_salt,
            svf.header.quality,
            &device.fingerprint,
        )
        .await?
    };

    // Convert hex key to SecureKey
    let key_bytes: [u8; 32] = hex::decode(&key_hex)
        .map_err(|e| AppError::Crypto(format!("Invalid key from server: {}", e)))?
        .try_into()
        .map_err(|_| AppError::Crypto("Key must be 32 bytes".to_string()))?;
    let key = SecureKey::new(key_bytes);
    drop(svf);

    // ─── Enable security protections ───

    // 1. Screen capture protection
    if let Some(window) = app_handle.get_webview_window("main") {
        if let Err(e) = crate::security::enable_capture_protection(&window) {
            log::warn!("Could not enable capture protection: {}", e);
        }
    }

    // 2. Run an initial security check (warn but don't block)
    let initial_status = crate::security::check_security();
    if !initial_status.is_safe {
        log::warn!("Security issues detected at playback start: {:?}", initial_status.violations);
        // Emit the violations to frontend (it'll show a warning banner)
        use tauri::Emitter;
        let _ = app_handle.emit("security-violation", &initial_status);
    }

    // 3. Start background security monitor
    let monitor = SecurityMonitor::start(app_handle.clone());
    *state.security_monitor.lock().await = Some(monitor);

    // 4. Start watermark rotation
    let user_email = {
        let lm = state.license_manager.lock().await;
        lm.user_email().unwrap_or("unknown").to_string()
    };
    let rotator = WatermarkRotator::start(app_handle.clone(), user_email);
    *state.watermark_rotator.lock().await = Some(rotator);

    // 5. Prepare the decrypted-stream state for the `stream` custom protocol.
    //    There is no HTTP server / port — playback is served over IPC inside
    //    the webview, so the stream is not reachable from any browser.
    let (playback, info) = prepare_playback(&svf_path, key)?;
    *state.active_playback.lock().unwrap() = Some(playback);

    // 6. Start periodic online re-validation so a revoked/deleted video stops
    //    in-progress playback (QA SP-009 / SP-014). Best-effort: it stays silent
    //    while offline, preserving the documented 20-day offline grace.
    let monitor = RevalidationMonitor::start(
        app_handle.clone(),
        state.license_manager.clone(),
        info.video_id.clone(),
        device.fingerprint.clone(),
    );
    *state.revalidation_monitor.lock().await = Some(monitor);

    log::info!("Playback started with security: {} ({})", info.title, info.url);
    Ok(info)
}

#[tauri::command]
pub async fn stop_playback(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    stop_all_playback_resources(&state, &app_handle).await;
    Ok(())
}

/// Helper: stop all playback-related resources (server, security, watermark)
async fn stop_all_playback_resources(state: &AppState, app_handle: &tauri::AppHandle) {
    // Clear the active playback so the `stream` protocol returns 404 and the
    // decrypted state is dropped (key zeroized).
    *state.active_playback.lock().unwrap() = None;

    // Stop the re-validation monitor
    if let Some(monitor) = state.revalidation_monitor.lock().await.take() {
        monitor.stop();
    }

    // Stop security monitor
    if let Some(monitor) = state.security_monitor.lock().await.take() {
        monitor.stop();
    }

    // Stop watermark rotation
    if let Some(rotator) = state.watermark_rotator.lock().await.take() {
        rotator.stop();
    }

    // Disable screen capture protection
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = crate::security::disable_capture_protection(&window);
    }

    log::info!("All playback resources stopped");
}
