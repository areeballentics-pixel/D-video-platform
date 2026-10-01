// jobs.rs — Job queue + status tracking + Tauri event emission.
//
// Each call to `start_encryption_job` from React creates a JobInfo, spawns a
// tokio task to run it, and emits "job:update" events so the React UI sees
// real-time progress without polling.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::errors::AppError;


/// Job lifecycle states. Stored as a string so the React UI can render
/// without keeping a parallel enum in sync.
pub mod status {
    pub const QUEUED: &str = "queued";
    pub const RUNNING: &str = "running";
    /// Encryption finished, registered with server, but the institute hasn't
    /// pasted Drive URLs yet → student can't play it.
    pub const AWAITING_URLS: &str = "awaiting_urls";
    /// download_urls populated for every encrypted quality.
    pub const LIVE: &str = "live";
    pub const FAILED: &str = "failed";
    pub const CANCELLED: &str = "cancelled";
}


#[derive(Debug, Clone, Serialize)]
pub struct JobInfo {
    pub id: String,
    pub video_id: String,
    pub title: String,
    pub input_path: String,
    pub output_path: Option<String>,
    pub quality_label: String,
    pub status: String,
    pub bytes_total: u64,
    pub bytes_processed: u64,
    pub error_message: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub svf_file_size: Option<u64>,
    pub content_hash_hex: Option<String>,
    pub needs_download_urls_for: Vec<String>,
    pub download_urls: BTreeMap<String, String>,
    /// True when the user has clicked "Cancel" — the runner checks this
    /// between chunks and aborts cleanly.
    pub cancel_requested: bool,
    /// Set when this job belongs to a folder batch. None for single-file jobs.
    pub batch_id: Option<String>,
    /// Human-readable batch name (= the folder name). None for single-file jobs.
    pub batch_name: Option<String>,
}


impl JobInfo {
    pub fn new_queued(
        title: String,
        input_path: String,
        quality_label: String,
        video_id: Uuid,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            video_id: video_id.to_string(),
            title,
            input_path,
            output_path: None,
            quality_label,
            status: status::QUEUED.to_string(),
            bytes_total: 0,
            bytes_processed: 0,
            error_message: None,
            started_at: None,
            finished_at: None,
            svf_file_size: None,
            content_hash_hex: None,
            needs_download_urls_for: Vec::new(),
            download_urls: BTreeMap::new(),
            cancel_requested: false,
            batch_id: None,
            batch_name: None,
        }
    }
}


/// Process-wide registry of encryption jobs. Survives for the lifetime of
/// the app; not persisted across launches (no need — jobs are short-lived).
pub struct JobRegistry {
    jobs: Mutex<Vec<JobInfo>>,
}


impl JobRegistry {
    pub fn new() -> Self {
        Self { jobs: Mutex::new(Vec::new()) }
    }

    pub fn add(&self, job: JobInfo) -> JobInfo {
        let mut g = self.jobs.lock().expect("jobs poisoned");
        g.insert(0, job.clone()); // newest first
        job
    }

    pub fn list(&self) -> Vec<JobInfo> {
        self.jobs.lock().expect("jobs poisoned").clone()
    }

    pub fn get(&self, id: &str) -> Option<JobInfo> {
        self.jobs
            .lock()
            .expect("jobs poisoned")
            .iter()
            .find(|j| j.id == id)
            .cloned()
    }

    pub fn update<F: FnOnce(&mut JobInfo)>(&self, id: &str, f: F) -> Option<JobInfo> {
        let mut g = self.jobs.lock().expect("jobs poisoned");
        for j in g.iter_mut() {
            if j.id == id {
                f(j);
                return Some(j.clone());
            }
        }
        None
    }

    pub fn request_cancel(&self, id: &str) -> bool {
        self.update(id, |j| j.cancel_requested = true).is_some()
    }
}


/// Emit a "job:update" event with the current state. React subscribes to
/// this in `useEffect` and merges into Zustand.
pub fn emit_update(app: &AppHandle, job: &JobInfo) {
    if let Err(e) = app.emit("job:update", job) {
        log::warn!("failed to emit job:update for {}: {}", job.id, e);
    }
}


/// Cancellation sentinel returned from the runner when the user clicked Cancel.
pub fn cancelled_error(id: &str) -> AppError {
    AppError::Job(format!("job {} cancelled", id))
}
