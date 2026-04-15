// API base URL — set via NEXT_PUBLIC_API_URL at build time (Vercel env var
// in production). Falls back to the local dev server.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ── Types ───────────────────────────────────────────────────────────────────

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user_id: string;
  email: string;
  tenant_id: string;
}

export interface UploadResponse {
  job_id: string;
  video_id: string;
}

export interface JobStatus {
  status: "queued" | "transcoding" | "encrypting" | "packaging" | "completed" | "failed";
  progress: number;
  detail: string;
  result?: Record<string, unknown>;
}

export interface Video {
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

export interface Device {
  device_id: string;
  // Truncated fingerprint (backend sends first 12 chars + ellipsis; the full
  // raw fingerprint is never exposed to the dashboard).
  fingerprint: string;
  hostname: string;
  os_version: string;
  is_active: boolean;
  registered_at: string;
  last_seen_at: string;
}

// ── API Client ──────────────────────────────────────────────────────────────

class ApiClient {
  private getToken(): string | null {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("access_token");
  }

  setToken(token: string): void {
    localStorage.setItem("access_token", token);
  }

  setRefreshToken(token: string): void {
    localStorage.setItem("refresh_token", token);
  }

  getRefreshToken(): string | null {
    return localStorage.getItem("refresh_token");
  }

  clearToken(): void {
    localStorage.removeItem("access_token");
    localStorage.removeItem("refresh_token");
    localStorage.removeItem("user_email");
    localStorage.removeItem("tenant_id");
  }

  isAuthenticated(): boolean {
    return !!this.getToken();
  }

  private async tryRefreshToken(): Promise<boolean> {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) return false;

    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      this.setToken(data.access_token);
      this.setRefreshToken(data.refresh_token);
      return true;
    } catch {
      return false;
    }
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    // Don't set Content-Type for FormData — browser sets it with boundary
    if (!(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    if (res.status === 401) {
      // Try to refresh the token before giving up
      const refreshed = await this.tryRefreshToken();
      if (refreshed) {
        // Retry the original request with the new token
        headers["Authorization"] = `Bearer ${this.getToken()}`;
        const retryRes = await fetch(`${API_BASE}${path}`, { ...options, headers });
        if (retryRes.ok) return retryRes.json() as Promise<T>;
      }
      // Refresh failed — redirect to login
      this.clearToken();
      if (typeof window !== "undefined") {
        window.location.href = "/login";
      }
      throw new Error("Session expired. Please log in again.");
    }

    if (!res.ok) {
      const body = await res.text();
      let message = `API error ${res.status}`;
      try {
        const json = JSON.parse(body);
        message = json.detail || json.message || message;
      } catch {
        // use default message
      }
      throw new Error(message);
    }

    return res.json() as Promise<T>;
  }

  // ── Auth ────────────────────────────────────────────────────────────────

  private getDashboardFingerprint(): string {
    // Use a stable fingerprint per browser — stored in localStorage
    // so repeated logins from the same browser don't create new devices
    let fp = localStorage.getItem("dashboard_fingerprint");
    if (!fp) {
      fp = `dashboard-${crypto.randomUUID()}`;
      localStorage.setItem("dashboard_fingerprint", fp);
    }
    return fp;
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    const fingerprint = this.getDashboardFingerprint();
    const data = await this.request<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        device_fingerprint: fingerprint,
      }),
    });
    this.setToken(data.access_token);
    this.setRefreshToken(data.refresh_token);
    localStorage.setItem("user_email", data.email);
    localStorage.setItem("tenant_id", data.tenant_id);
    return data;
  }

  // ── Videos ──────────────────────────────────────────────────────────────

  async listVideos(): Promise<Video[]> {
    const data = await this.request<{ videos: Video[] }>("/api/admin/videos");
    return data.videos;
  }

  async uploadVideo(
    file: File,
    title: string,
    qualities: string[],
    onProgress?: (percent: number) => void
  ): Promise<UploadResponse> {
    const token = this.getToken();
    if (!token) throw new Error("Not authenticated");

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE}/api/admin/videos/upload`);
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else if (xhr.status === 401) {
          this.clearToken();
          window.location.href = "/login";
          reject(new Error("Unauthorized"));
        } else {
          let msg = `Upload failed (${xhr.status})`;
          try {
            const body = JSON.parse(xhr.responseText);
            msg = body.detail || msg;
          } catch {
            // use default
          }
          reject(new Error(msg));
        }
      });

      xhr.addEventListener("error", () => reject(new Error("Upload failed")));

      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", title);
      formData.append("qualities", qualities.join(","));
      xhr.send(formData);
    });
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    return this.request<JobStatus>(`/api/admin/videos/jobs/${jobId}`);
  }

  async registerVideo(jobId: string): Promise<unknown> {
    return this.request(`/api/admin/videos/jobs/${jobId}/register`, {
      method: "POST",
    });
  }

  async downloadVideo(videoId: string, quality: string): Promise<void> {
    const token = this.getToken();
    if (!token) throw new Error("Not authenticated");

    const res = await fetch(
      `${API_BASE}/api/admin/videos/${videoId}/download/${quality}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (res.status === 401) {
      this.clearToken();
      window.location.href = "/login";
      return;
    }

    if (!res.ok) throw new Error("Download failed");

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${videoId}_${quality}.svf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async deleteVideo(videoId: string): Promise<void> {
    await this.request(`/api/admin/videos/${videoId}`, { method: "DELETE" });
  }

  // ── Students ────────────────────────────────────────────────────────────

  async listStudents(): Promise<Student[]> {
    const data = await this.request<{ students: Student[] }>(
      "/api/admin/students"
    );
    return data.students;
  }

  async createStudent(
    email: string,
    password: string,
    licenseKey?: string
  ): Promise<{ user_id: string; email: string; license_key: string }> {
    const formData = new FormData();
    formData.append("email", email);
    formData.append("password", password);
    if (licenseKey) formData.append("license_key", licenseKey);

    return this.request("/api/admin/students", {
      method: "POST",
      body: formData,
    });
  }

  async listDevices(studentId: string): Promise<Device[]> {
    const data = await this.request<{ devices: Device[] }>(
      `/api/admin/students/${studentId}/devices`
    );
    return data.devices;
  }

  async deregisterDevice(
    studentId: string,
    deviceId: string
  ): Promise<void> {
    await this.request(
      `/api/admin/students/${studentId}/devices/${deviceId}`,
      { method: "DELETE" }
    );
  }
}

export const api = new ApiClient();
