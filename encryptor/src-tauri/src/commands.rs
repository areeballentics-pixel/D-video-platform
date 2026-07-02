// commands.rs — Tauri IPC handlers callable from React via `invoke()`.
//
// Each command is a thin layer over AppState + ApiClient + the encryption
// pipeline. Long-running work (encryption) runs in spawned tokio tasks and
// streams progress back to React via `emit("job:update", ...)`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::api_client::{
    QualityEncryptionParams, RegisterEncryptedVideoRequest,
};
use crate::errors::AppError;
use crate::jobs::{self, status, JobInfo};
use crate::keystore;
use crate::mp4_probe;
use crate::pipeline::{self, EncryptJobInputs};
use crate::state::AppState;


// ─── App-state introspection ────────────────────────────────────────────────


#[derive(Debug, Clone, Serialize)]
pub struct AppStatus {
    pub server_url: String,
    pub authenticated: bool,
    pub master_key_loaded: bool,
    /// True only if the loaded master key belongs to the logged-in tenant.
    /// False after a tenant switch with a stale key → UI forces re-registration.
    pub master_key_matches_tenant: bool,
    pub last_admin_email: Option<String>,
    pub encryptor_device_id: Option<String>,
    pub tenant_id: Option<String>,
    pub tenant_name: Option<String>,
    pub output_dir: String,
    pub max_concurrent_jobs: u32,
}


fn default_output_dir() -> String {
    if let Some(dirs) = directories::UserDirs::new() {
        if let Some(docs) = dirs.document_dir() {
            return docs.join("SVP Encryptor").join("output").to_string_lossy().to_string();
        }
    }
    "./svp-encryptor-output".to_string()
}


#[tauri::command]
pub async fn get_status(state: State<'_, AppState>) -> Result<AppStatus, AppError> {
    let cfg = state.config.lock().await.clone();
    let mk_loaded = state.master_key.lock().await.is_some();
    let auth = state.api.is_authenticated().await;
    // A loaded master key is only usable if it belongs to the tenant we're
    // logged into. After switching tenants the previous tenant's key is still
    // cached (master_key_loaded=true) but must not be used — the UI reads this
    // to force re-registration instead of dropping the admin into an encryptor
    // that can't encrypt for the new tenant. A key whose tenant was never
    // recorded (an older registration) is UNCONFIRMED → treated as not-matching
    // so the UI forces a re-registration (which records the tenant). A one-time
    // re-register is far safer than silently encrypting with a stale/wrong-tenant
    // key and producing undecryptable files.
    let mk_matches = mk_loaded
        && match (&cfg.master_key_tenant_id, &cfg.tenant_id) {
            (Some(mk), Some(t)) => mk == t,
            _ => false,
        };
    Ok(AppStatus {
        server_url: cfg.server_url,
        authenticated: auth,
        master_key_loaded: mk_loaded,
        master_key_matches_tenant: mk_matches,
        last_admin_email: cfg.last_admin_email,
        encryptor_device_id: cfg.encryptor_device_id,
        tenant_id: cfg.tenant_id,
        tenant_name: cfg.tenant_name,
        output_dir: cfg.output_dir.unwrap_or_else(default_output_dir),
        max_concurrent_jobs: cfg.max_concurrent_jobs,
    })
}


// ─── Auth / registration ────────────────────────────────────────────────────


#[derive(Debug, Clone, Serialize)]
pub struct LoginResult {
    pub email: String,
    pub tenant_id: String,
}


#[tauri::command]
pub async fn login(
    email: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<LoginResult, AppError> {
    // Use a stable per-install fingerprint (svf-core cached) so re-launching
    // doesn't burn a "device" slot in the player schema for the encryptor's
    // login. The /encryptors/register call below uses a separate fingerprint.
    let fp = svf_core::collect_fingerprint()?;
    let resp = state
        .api
        .login(
            &email,
            &password,
            &format!("encryptor-app-{}", fp.fingerprint),
            &fp.hostname,
            &fp.os_version,
        )
        .await?;

    // Persist the non-secret state.
    {
        let mut cfg = state.config.lock().await;
        cfg.last_admin_email = Some(resp.email.clone());
        cfg.tenant_id = Some(resp.tenant_id.clone());
        keystore::save_config(&cfg).ok();
    }

    Ok(LoginResult {
        email: resp.email,
        tenant_id: resp.tenant_id,
    })
}


#[derive(Debug, Clone, Serialize)]
pub struct RegisterEncryptorResult {
    pub encryptor_device_id: String,
    pub master_key_hex: String,         // shown ONCE to the admin for offline backup
    pub seats_used: u32,
    pub seats_total: u32,
    pub is_first_registration: bool,
}


#[tauri::command]
pub async fn register_encryptor(
    password: String,
    state: State<'_, AppState>,
) -> Result<RegisterEncryptorResult, AppError> {
    let fp = svf_core::collect_fingerprint()?;
    let resp = state
        .api
        .register_encryptor(&password, &fp.fingerprint, &fp.hostname, &fp.os_version)
        .await?;

    // Decode + cache + persist.
    let master_bytes = hex::decode(&resp.master_key_hex)
        .map_err(|e| AppError::Encryption(format!("bad master_key hex: {}", e)))?;
    if master_bytes.len() != 32 {
        return Err(AppError::Encryption("master_key must be 32 bytes".into()));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&master_bytes);

    {
        let mut mk = state.master_key.lock().await;
        *mk = Some(arr);
    }

    keystore::save_master_key(&resp.master_key_hex)?;

    {
        let mut cfg = state.config.lock().await;
        cfg.encryptor_device_id = Some(resp.encryptor_device_id.clone());
        // Record which tenant this master key belongs to (the logged-in tenant),
        // so start_encryption_job can reject a stale key after a tenant switch.
        cfg.master_key_tenant_id = cfg.tenant_id.clone();
        keystore::save_config(&cfg).ok();
    }

    Ok(RegisterEncryptorResult {
        encryptor_device_id: resp.encryptor_device_id,
        master_key_hex: resp.master_key_hex,
        seats_used: resp.seats_used,
        seats_total: resp.seats_total,
        is_first_registration: resp.is_first_registration,
    })
}


#[tauri::command]
pub async fn refresh_master_key(
    password: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let cfg_snapshot = state.config.lock().await.clone();
    let device_id = cfg_snapshot
        .encryptor_device_id
        .ok_or_else(|| AppError::Validation("no encryptor_device_id on file — register first".into()))?;
    let fp = svf_core::collect_fingerprint()?;
    let resp = state
        .api
        .refresh_master_key(&password, &device_id, &fp.fingerprint)
        .await?;

    let bytes = hex::decode(&resp.master_key_hex)
        .map_err(|e| AppError::Encryption(format!("bad master_key hex: {}", e)))?;
    if bytes.len() != 32 {
        return Err(AppError::Encryption("master_key must be 32 bytes".into()));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    *state.master_key.lock().await = Some(arr);

    keystore::save_master_key(&resp.master_key_hex)?;
    {
        let mut cfg = state.config.lock().await;
        cfg.master_key_tenant_id = cfg.tenant_id.clone();
        keystore::save_config(&cfg).ok();
    }
    Ok(())
}


#[tauri::command]
pub async fn logout(state: State<'_, AppState>) -> Result<(), AppError> {
    state.api.clear_tokens().await;
    Ok(())
}


/// Wipe the stored master key + tokens. Used when the laptop is being
/// retired or a different admin is taking over.
#[tauri::command]
pub async fn forget_master_key(state: State<'_, AppState>) -> Result<(), AppError> {
    state.api.clear_tokens().await;
    *state.master_key.lock().await = None;
    keystore::delete_master_key()?;
    {
        let mut cfg = state.config.lock().await;
        cfg.master_key_tenant_id = None;
        keystore::save_config(&cfg).ok();
    }
    Ok(())
}


// ─── Job creation + listing ────────────────────────────────────────────────


#[derive(Debug, serde::Deserialize)]
pub struct StartJobInput {
    pub input_path: String,
    pub title: String,
    /// Optional override; if None, the encryptor auto-detects from MP4 dims.
    pub quality_label: Option<String>,
    /// Optional video_id to attach this quality to an existing video record.
    /// If None, a new UUID is generated and a brand-new Video row is created
    /// when the encryption is registered with the server.
    pub existing_video_id: Option<String>,
}


#[tauri::command]
pub async fn start_encryption_job(
    input: StartJobInput,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<JobInfo, AppError> {
    // ── Preflight checks ──
    if state.master_key.lock().await.is_none() {
        return Err(AppError::Auth(
            "Master key not loaded — register the encryptor first".into(),
        ));
    }
    let cfg = state.config.lock().await.clone();
    let tenant_id_str = cfg
        .tenant_id
        .clone()
        .ok_or_else(|| AppError::Auth("no tenant context — log in first".into()))?;
    let tenant_id = Uuid::parse_str(&tenant_id_str)
        .map_err(|_| AppError::Validation("tenant_id is not a UUID".into()))?;

    // ── Guard: the cached master key must be CONFIRMED to belong to the tenant
    // we're logged into. If it belongs to a different tenant, OR its tenant was
    // never recorded (an older registration), refuse — otherwise we'd encrypt
    // with a stale/unverified key and produce a permanently undecryptable .svf
    // (silent data loss). The UI's re-registration gate normally catches this
    // first; this is the last line of defense.
    if cfg.master_key_tenant_id.as_deref() != Some(tenant_id_str.as_str()) {
        return Err(AppError::Auth(
            "The loaded master key isn't confirmed for the tenant you're logged \
             into. Re-register the encryptor for this tenant (Register Encryptor) \
             before encrypting.".into(),
        ));
    }

    // ── Hard gate: reject non-video / corrupted inputs BEFORE spawning a job ──
    // (ENC-003/ENC-004) A .txt renamed .mp4 or a hex-corrupted MP4 must never
    // reach the encryption pipeline. This returns synchronously, so the error
    // surfaces in JobsPage's `handleStart` catch as a clean message.
    mp4_probe::validate_video_file(&input.input_path)?;

    // ── Probe metadata for auto-quality + dimensions ──
    let meta = mp4_probe::probe(&input.input_path).unwrap_or_else(|_| {
        mp4_probe::VideoMeta::unknown()
    });
    let quality_label = input
        .quality_label
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| meta.quality_label.clone());

    // Resolve video_id (existing or new).
    let video_id = match input.existing_video_id {
        Some(s) if !s.is_empty() => Uuid::parse_str(&s)
            .map_err(|_| AppError::Validation("existing_video_id is not a UUID".into()))?,
        _ => Uuid::new_v4(),
    };

    // Output path: {output_dir}/{video_id}_{quality}.svf
    let output_dir = PathBuf::from(
        cfg.output_dir.clone().unwrap_or_else(default_output_dir),
    );
    std::fs::create_dir_all(&output_dir)?;
    let output_path = output_dir.join(format!("{}_{}.svf", video_id, quality_label));

    let mut job = JobInfo::new_queued(
        input.title.clone(),
        input.input_path.clone(),
        quality_label.clone(),
        video_id,
    );
    job.output_path = Some(output_path.to_string_lossy().to_string());
    let job = state.jobs.add(job);
    jobs::emit_update(&app, &job);

    // Spawn the runner. Cloning Arcs is cheap; the spawned task lives until
    // encryption + registration finish. We hand the runner its own copy of
    // the job snapshot and return the original to React for immediate UI.
    let runner_job = job.clone();
    let job_id = job.id.clone();
    let app_handle = app.clone();
    let api = state.api.clone();
    let jobs_reg = state.jobs.clone();
    let semaphore = state.job_semaphore.clone();
    let master_key = state
        .master_key
        .lock()
        .await
        .expect("checked above");

    tokio::spawn(async move {
        // Wait for a free slot.
        let _permit = semaphore.acquire().await.ok();

        // Mark running + record start time.
        let started = chrono_now();
        let updated = jobs_reg.update(&job_id, |j| {
            if j.cancel_requested {
                j.status = status::CANCELLED.to_string();
                j.finished_at = Some(started.clone());
            } else {
                j.status = status::RUNNING.to_string();
                j.started_at = Some(started);
            }
        });
        if let Some(j) = updated {
            jobs::emit_update(&app_handle, &j);
            if j.status == status::CANCELLED {
                return;
            }
        }

        // Run the pipeline on a blocking thread (file I/O + AES) so we
        // don't pin a tokio worker for the whole encryption.
        let inputs = EncryptJobInputs {
            input_path: PathBuf::from(&runner_job.input_path),
            output_path: output_path.clone(),
            video_id,
            tenant_id,
            master_key,
            title: runner_job.title.clone(),
            quality_label: quality_label.clone(),
            meta: meta.clone(),
        };

        let app_for_progress = app_handle.clone();
        let jobs_for_progress = jobs_reg.clone();
        let job_id_for_progress = job_id.clone();

        let encrypt_result = tokio::task::spawn_blocking(move || {
            pipeline::encrypt_to_svf(inputs, |bytes_processed, bytes_total| {
                if let Some(j) = jobs_for_progress.update(&job_id_for_progress, |j| {
                    j.bytes_processed = bytes_processed;
                    j.bytes_total = bytes_total;
                }) {
                    jobs::emit_update(&app_for_progress, &j);
                }
            })
        })
        .await;

        let res = match encrypt_result {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                fail_job(&jobs_reg, &app_handle, &job_id, e.to_string());
                return;
            }
            Err(e) => {
                fail_job(&jobs_reg, &app_handle, &job_id, format!("task join: {}", e));
                return;
            }
        };

        // Register the encryption with the server.
        let mut params_map: BTreeMap<String, QualityEncryptionParams> = BTreeMap::new();
        params_map.insert(
            quality_label.clone(),
            QualityEncryptionParams {
                salt: res.encryption_salt_hex.clone(),
                nonce: res.encryption_nonce_hex.clone(),
            },
        );
        let mut hashes: BTreeMap<String, String> = BTreeMap::new();
        hashes.insert(quality_label.clone(), res.content_hash_hex.clone());
        let mut sizes: BTreeMap<String, u64> = BTreeMap::new();
        sizes.insert(quality_label.clone(), res.svf_file_size);

        let request = RegisterEncryptedVideoRequest {
            video_id: video_id.to_string(),
            title: runner_job.title.clone(),
            duration_ms: res.duration_ms,
            qualities: vec![quality_label.clone()],
            encryption_params: params_map,
            content_hashes: hashes,
            file_sizes: sizes,
        };

        match api.register_encrypted_video(&request).await {
            Ok(server_resp) => {
                if let Some(j) = jobs_reg.update(&job_id, |j| {
                    // Always LIVE on successful registration. Drive URLs are
                    // optional — the institute can distribute by USB / pendrive
                    // / direct copy too, so an empty download_urls map is
                    // valid and shouldn't block the workflow with an
                    // "awaiting urls" badge.
                    j.status = status::LIVE.to_string();
                    j.finished_at = Some(chrono_now());
                    j.svf_file_size = Some(res.svf_file_size);
                    j.content_hash_hex = Some(res.content_hash_hex.clone());
                    j.needs_download_urls_for = server_resp.needs_download_urls_for.clone();
                }) {
                    jobs::emit_update(&app_handle, &j);
                }
            }
            Err(e) => {
                fail_job(
                    &jobs_reg,
                    &app_handle,
                    &job_id,
                    format!("register-encrypted: {}", e),
                );
            }
        }
    });

    Ok(job)
}


fn fail_job(reg: &Arc<jobs::JobRegistry>, app: &AppHandle, job_id: &str, err: String) {
    if let Some(j) = reg.update(job_id, |j| {
        j.status = status::FAILED.to_string();
        j.finished_at = Some(chrono_now());
        j.error_message = Some(err);
    }) {
        jobs::emit_update(app, &j);
    }
}


fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Plain seconds-since-epoch is enough for the dashboard's "X minutes ago"
    // logic. We don't need full RFC3339 here; React formats from this.
    format!("{}", n)
}


#[tauri::command]
pub async fn list_jobs(state: State<'_, AppState>) -> Result<Vec<JobInfo>, AppError> {
    Ok(state.jobs.list())
}


#[tauri::command]
pub async fn cancel_job(
    job_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    if state.jobs.request_cancel(&job_id) {
        if let Some(j) = state.jobs.get(&job_id) {
            jobs::emit_update(&app, &j);
        }
        Ok(())
    } else {
        Err(AppError::Validation(format!("job {} not found", job_id)))
    }
}


// ─── Awaiting-upload: paste Drive URLs ──────────────────────────────────────


#[derive(Debug, serde::Deserialize)]
pub struct SubmitUrlsInput {
    pub job_id: String,
    /// Map of quality → URL. Only entries for qualities listed in the job's
    /// `needs_download_urls_for` are sent to the server.
    pub urls: BTreeMap<String, String>,
}


#[tauri::command]
pub async fn submit_download_urls(
    input: SubmitUrlsInput,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<JobInfo, AppError> {
    let job = state
        .jobs
        .get(&input.job_id)
        .ok_or_else(|| AppError::Validation("job not found".into()))?;

    let resp = state
        .api
        .put_download_urls(&job.video_id, &input.urls)
        .await?;

    let new_needs = resp
        .get("needs_download_urls_for")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let server_status = resp
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("awaiting_urls")
        .to_string();

    let updated = state
        .jobs
        .update(&input.job_id, |j| {
            for (q, u) in &input.urls {
                j.download_urls.insert(q.clone(), u.clone());
            }
            j.needs_download_urls_for = new_needs.clone();
            j.status = if server_status == "live" {
                status::LIVE.to_string()
            } else {
                status::AWAITING_URLS.to_string()
            };
        })
        .ok_or_else(|| AppError::Validation("update failed".into()))?;
    jobs::emit_update(&app, &updated);
    Ok(updated)
}


// ─── Settings ───────────────────────────────────────────────────────────────


#[derive(Debug, serde::Deserialize)]
pub struct SetSettingsInput {
    pub server_url: Option<String>,
    pub output_dir: Option<String>,
    pub max_concurrent_jobs: Option<u32>,
}


#[tauri::command]
pub async fn set_settings(
    input: SetSettingsInput,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let mut cfg = state.config.lock().await;
    if let Some(url) = input.server_url {
        cfg.server_url = url.trim_end_matches('/').to_string();
        // Note: changing the server URL on a logged-in instance leaves stale
        // tokens. The frontend's settings page should warn + force a re-login.
    }
    if let Some(dir) = input.output_dir {
        cfg.output_dir = Some(dir);
    }
    if let Some(n) = input.max_concurrent_jobs {
        cfg.max_concurrent_jobs = n.max(1).min(8);
    }
    keystore::save_config(&cfg)?;
    Ok(())
}


// ─── Dev / debug helpers ────────────────────────────────────────────────────


#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}


#[tauri::command]
pub async fn get_device_info() -> Result<svf_core::DeviceInfo, AppError> {
    Ok(svf_core::collect_fingerprint()?)
}


// ─── Bearer token + base URL exposure for the React-side REST client ───────
//
// The React UI now hosts a full admin surface (courses, students, etc.) that
// needs to call /api/admin/* endpoints directly. Rather than wrap every
// endpoint as a Tauri command, we expose just enough of the auth context
// for `fetch()` from React to work — same trust model as a browser tab
// holding a localStorage bearer token.

#[derive(Debug, Clone, serde::Serialize)]
pub struct ApiAuth {
    pub server_url: String,
    pub access_token: Option<String>,
}


#[tauri::command]
pub async fn get_api_auth(state: State<'_, AppState>) -> Result<ApiAuth, AppError> {
    let token = state.api.access_token().await;
    Ok(ApiAuth {
        server_url: state.api.base_url().to_string(),
        access_token: token,
    })
}
