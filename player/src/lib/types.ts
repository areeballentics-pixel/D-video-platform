/** Video info from scanning .svf file headers (matches Rust's SvfInfo) */
export interface SvfInfo {
  video_id: string; // file path (in Sprint 4) or UUID
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
