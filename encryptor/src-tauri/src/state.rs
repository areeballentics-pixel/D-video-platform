// state.rs — Application state shared across Tauri commands.
//
// AppState is `tauri::manage`d so every command can access:
//   - the API client (with current bearer tokens)
//   - persistent config (server URL, encryptor_device_id, tenant_id)
//   - the loaded master key (only after registration succeeds)
//   - the job registry (queue + history of encryption jobs)

use std::sync::Arc;

use tokio::sync::{Mutex, Semaphore};

use crate::api_client::ApiClient;
use crate::errors::AppError;
use crate::jobs::JobRegistry;
use crate::keystore::{self, AppConfig};


pub struct AppState {
    pub api: Arc<ApiClient>,
    pub config: Arc<Mutex<AppConfig>>,
    pub master_key: Arc<Mutex<Option<[u8; 32]>>>,
    pub jobs: Arc<JobRegistry>,
    /// Caps simultaneously-running encryption jobs. Default 1; tunable from
    /// Settings via `set_max_concurrent_jobs`.
    pub job_semaphore: Arc<Semaphore>,
}


impl AppState {
    pub fn new() -> Result<Self, AppError> {
        let config = keystore::load_config();
        let api = ApiClient::new(&config.server_url)?;

        // If a master key is in the OS keychain from a previous run, hydrate
        // it so the user lands directly on the jobs page.
        let master_key = match keystore::load_master_key() {
            Ok(Some(hex_str)) => match hex::decode(hex_str.trim()) {
                Ok(bytes) if bytes.len() == 32 => {
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(&bytes);
                    Some(arr)
                }
                _ => None,
            },
            _ => None,
        };

        let max_jobs = config.max_concurrent_jobs.max(1) as usize;

        Ok(Self {
            api: Arc::new(api),
            config: Arc::new(Mutex::new(config)),
            master_key: Arc::new(Mutex::new(master_key)),
            jobs: Arc::new(JobRegistry::new()),
            job_semaphore: Arc::new(Semaphore::new(max_jobs)),
        })
    }
}
