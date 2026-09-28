/** Video info from scanning .svf file headers (matches Rust's SvfInfo) */
export interface SvfInfo {
  video_id: string; // 32-char hex UUID from .svf header
  file_path?: string; // Local file path on disk
  title: string;
  duration_ms: number;
  width: number;
  height: number;
  quality: string;
}

/** Playback info returned when starting video (matches Rust's PlaybackInfo) */
export interface PlaybackInfo {
  url: string;
  video_id: string;
  title: string;
  duration_ms: number;
  width: number;
  height: number;
  quality: string;
}

/** Device info (matches Rust's DeviceInfo) */
export interface DeviceInfo {
  fingerprint: string;
  hostname: string;
  os_version: string;
  device_id: string | null;
}

/** Student enrolled course/batch video */
export interface StudentBatchVideo {
  video_id: string; // Hyphenated UUID
  video_id_hex: string; // 32-char hex string
  title: string;
  duration_ms: number;
  display_order: number;
  is_free_preview: boolean;
  qualities: string[];
}

/** Student enrolled course/batch */
export interface StudentBatch {
  id: string;
  name: string;
  description: string;
  thumbnail_url: string | null;
  tags: string[];
  display_order: number;
  enrolled_at: string | null;
  expires_at: string | null;
  videos: StudentBatchVideo[];
}

export interface StudentBatchesResponse {
  batches: StudentBatch[];
}
