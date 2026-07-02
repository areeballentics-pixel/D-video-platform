// Mirrors the Rust types in commands.rs / jobs.rs. Keep in sync manually —
// the Tauri ecosystem doesn't auto-generate TS bindings without an extra crate.

export interface AppStatus {
  server_url: string;
  authenticated: boolean;
  master_key_loaded: boolean;
  master_key_matches_tenant: boolean;
  last_admin_email: string | null;
  encryptor_device_id: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  output_dir: string;
  max_concurrent_jobs: number;
}

export interface LoginResult {
  email: string;
  tenant_id: string;
}

export interface RegisterEncryptorResult {
  encryptor_device_id: string;
  master_key_hex: string;
  seats_used: number;
  seats_total: number;
  is_first_registration: boolean;
}

export type JobStatus =
  | "queued"
  | "running"
  | "awaiting_urls"
  | "live"
  | "failed"
  | "cancelled";

export interface JobInfo {
  id: string;
  video_id: string;
  title: string;
  input_path: string;
  output_path: string | null;
  quality_label: string;
  status: JobStatus;
  bytes_total: number;
  bytes_processed: number;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  svf_file_size: number | null;
  content_hash_hex: string | null;
  needs_download_urls_for: string[];
  download_urls: Record<string, string>;
  cancel_requested: boolean;
}
