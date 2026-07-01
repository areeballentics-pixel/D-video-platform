// keystore.rs — OS keychain integration for the tenant master key.
//
// Storage rules:
//   - Master key (32 bytes hex) → OS keychain entry, never in a file.
//   - encryptor_device_id, last admin email, server URL → JSON config file
//     (non-secret; convenience only, OK to be readable on disk).
//
// Keychain backends per platform:
//   - macOS  : Keychain Services
//   - Windows: Credential Manager (Generic credential)
//   - Linux  : Secret Service (gnome-keyring, KWallet, etc.)

use std::fs;
use std::path::PathBuf;

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

use crate::errors::AppError;

const KEYCHAIN_SERVICE: &str = "com.svp.encryptor";
const KEYCHAIN_USER_MASTER: &str = "tenant-master-key";

/// Non-secret app state persisted across launches, alongside (NOT in) the keychain.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub server_url: String,
    pub last_admin_email: Option<String>,
    pub encryptor_device_id: Option<String>,
    pub tenant_id: Option<String>,
    pub tenant_name: Option<String>,
    /// Which tenant the cached master key belongs to (set on register/refresh).
    /// Encryption is blocked if this doesn't match the logged-in tenant, so a
    /// stale key from a previous tenant can never silently encrypt undecryptable
    /// files. `#[serde(default)]` keeps old config.json files loading cleanly.
    #[serde(default)]
    pub master_key_tenant_id: Option<String>,
    /// Where the encryptor writes finished .svf files. Defaults to
    /// "<documents>/SVP Encryptor/output". Institute admin can override.
    pub output_dir: Option<String>,
    /// Concurrent jobs. Default 1 — most institutes are CPU-/disk-bound on
    /// a single video at a time anyway, since we're not transcoding.
    pub max_concurrent_jobs: u32,
}

impl AppConfig {
    fn defaults() -> Self {
        let default_url = option_env!("SVP_SERVER_URL")
            .unwrap_or("http://127.0.0.1:8000")
            .to_string();
        AppConfig {
            server_url: default_url,
            last_admin_email: None,
            encryptor_device_id: None,
            tenant_id: None,
            tenant_name: None,
            master_key_tenant_id: None,
            output_dir: None,
            max_concurrent_jobs: 1,
        }
    }
}

fn config_path() -> Result<PathBuf, AppError> {
    let dirs = ProjectDirs::from("com", "svp", "encryptor")
        .ok_or_else(|| AppError::Validation("no project dir on this OS".into()))?;
    let data = dirs.data_dir();
    fs::create_dir_all(data)?;
    Ok(data.join("config.json"))
}

pub fn load_config() -> AppConfig {
    let Ok(path) = config_path() else {
        return AppConfig::defaults();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return AppConfig::defaults();
    };
    let mut cfg: AppConfig = serde_json::from_str(&text).unwrap_or_default();
    if cfg.server_url.is_empty() {
        cfg.server_url = AppConfig::defaults().server_url;
    }
    if cfg.max_concurrent_jobs == 0 {
        cfg.max_concurrent_jobs = 1;
    }
    cfg
}

pub fn save_config(cfg: &AppConfig) -> Result<(), AppError> {
    let path = config_path()?;
    let json = serde_json::to_string_pretty(cfg)?;
    fs::write(&path, json)?;
    Ok(())
}

// ─── Master key in OS keychain ──────────────────────────────────────────────

pub fn save_master_key(master_key_hex: &str) -> Result<(), AppError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER_MASTER)
        .map_err(|e| AppError::Keychain(format!("entry: {}", e)))?;
    entry
        .set_password(master_key_hex)
        .map_err(|e| AppError::Keychain(format!("set: {}", e)))
}

pub fn load_master_key() -> Result<Option<String>, AppError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER_MASTER)
        .map_err(|e| AppError::Keychain(format!("entry: {}", e)))?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keychain(format!("get: {}", e))),
    }
}

pub fn delete_master_key() -> Result<(), AppError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER_MASTER)
        .map_err(|e| AppError::Keychain(format!("entry: {}", e)))?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keychain(format!("delete: {}", e))),
    }
}
