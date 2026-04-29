// Shared TS types — match the server's response shapes from
// /api/auth/login, /api/videos/key, /api/videos/licensed-keys, etc.

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user_id: string;
  email: string;
  tenant_id: string;
  licensed_video_keys?: LicensedKey[];
}

export interface LicensedKey {
  video_id: string;
  quality: string;
  key: string;
  download_url?: string | null;
  content_hash?: string | null;
  file_size?: number | null;
}

export interface VideoKeyResponse {
  key: string;
  quality: string;
  download_url: string | null;
  content_hash: string | null;
  file_size: number | null;
  is_stream_only: boolean;
  chapters: Array<{ title: string; start_ms: number }>;
}

export interface Course {
  id: string;
  name: string;
  description: string;
  thumbnail_url: string | null;
  intro_video_id: string | null;
  is_published: boolean;
  is_archived: boolean;
  tags: string[];
  resource_attachments: Array<{ label: string; url: string }>;
  video_count: number;
  enrollment_count: number;
  created_at: string;
  updated_at: string;
}

export interface CourseVideo {
  video_id: string;
  title: string;
  qualities: string[];
  duration_ms: number;
  status: string;
  is_free_preview: boolean;
  display_order: number;
}

export interface TenantBranding {
  logo_url: string | null;
  primary_color: string | null;
  support_email: string | null;
  custom_welcome_message: string | null;
}
