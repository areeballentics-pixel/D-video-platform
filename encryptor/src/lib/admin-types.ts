// Shared TS types for the admin surface migrated into the encryptor app.
// Mirror the server's response shapes; keep in sync when those change.

export interface Course {
  id: string;
  name: string;
  description: string;
  thumbnail_url: string | null;
  intro_video_id: string | null;
  display_order: number;
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

export interface AdminVideo {
  video_id: string;
  title: string;
  qualities: string[];
  duration_ms: number;
  created_at: string;
}

export interface Student {
  user_id: string;
  email: string;
  license_key: string;
  is_active: boolean;
  max_devices: number;
  active_devices: number;
  created_at: string;
}

export interface Enrollment {
  id: string;
  user_id: string;
  user_email: string;
  course_id: string;
  course_name: string;
  enrolled_at: string;
  expires_at: string | null;
  is_active: boolean;
}
