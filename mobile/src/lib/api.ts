// API client — same shape as desktop player + dashboards. Auth tokens come
// from the secure keychain (lib/storage.ts), not from the API client itself.
// We pass them in via a callback so the auth store can refresh them
// transparently on 401.

import { Platform } from "react-native";
import {
  Course,
  CourseVideo,
  LoginResponse,
  TenantBranding,
  VideoKeyResponse,
} from "./types";

// Default server URL per-platform:
//   - Android emulator can't reach 127.0.0.1 on the host; 10.0.2.2 is the
//     Android emulator alias for the developer's machine.
//   - iOS simulator can use localhost directly.
//   - Real devices need an actual public URL — set via SVP_SERVER_URL.
const DEFAULT_SERVER_URL =
  // @ts-expect-error — bundler may inline this; runtime fallback below
  (typeof process !== "undefined" && process.env && process.env.SVP_SERVER_URL) ||
  (Platform.OS === "android" ? "http://10.0.2.2:8000" : "http://localhost:8000");

export type TokenProvider = () => Promise<string | null>;
export type TokenRefresher = () => Promise<boolean>;

export class ApiClient {
  private baseUrl: string;
  private tokenProvider: TokenProvider | null = null;
  private tokenRefresher: TokenRefresher | null = null;

  constructor(baseUrl: string = DEFAULT_SERVER_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, "");
  }

  /** Auth store wires up the token provider so we don't tightly couple. */
  setAuth(provider: TokenProvider, refresher: TokenRefresher): void {
    this.tokenProvider = provider;
    this.tokenRefresher = refresher;
  }

  private async authedHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.tokenProvider) {
      const token = await this.tokenProvider();
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const fire = async (): Promise<Response> => {
      const headers = await this.authedHeaders();
      return fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers ?? {}) },
      });
    };

    let res = await fire();
    if (res.status === 401 && this.tokenRefresher) {
      const ok = await this.tokenRefresher();
      if (ok) res = await fire();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      try {
        const json = JSON.parse(text);
        throw new Error(json.detail ?? json.message ?? `${res.status}`);
      } catch {
        throw new Error(`${res.status}: ${text || res.statusText}`);
      }
    }
    return (await res.json()) as T;
  }

  // ── Auth ─────────────────────────────────────────────────────────────

  async login(
    email: string,
    password: string,
    deviceFingerprint: string,
    hostname: string,
    osVersion: string,
  ): Promise<LoginResponse> {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        device_fingerprint: deviceFingerprint,
        hostname,
        os_version: osVersion,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      try {
        throw new Error(JSON.parse(t).detail ?? "Login failed");
      } catch {
        throw new Error(`Login failed (${res.status})`);
      }
    }
    return res.json();
  }

  async refreshTokens(refreshToken: string): Promise<{
    access_token: string;
    refresh_token: string;
  }> {
    const res = await fetch(`${this.baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) throw new Error("Refresh failed");
    return res.json();
  }

  async logout(): Promise<void> {
    try {
      await this.request("/api/auth/logout", { method: "POST" });
    } catch {
      // best-effort
    }
  }

  // ── Videos ───────────────────────────────────────────────────────────

  async getVideoKey(
    videoId: string,
    quality: string,
    deviceFingerprint: string,
  ): Promise<VideoKeyResponse> {
    return this.request<VideoKeyResponse>("/api/videos/key", {
      method: "POST",
      body: JSON.stringify({
        video_id: videoId,
        quality,
        device_fingerprint: deviceFingerprint,
      }),
    });
  }

  // ── Courses (student-visible subset; admin endpoints not exposed here) ──

  async listMyCourses(): Promise<Course[]> {
    // Reuses the admin courses endpoint — students should hit a dedicated
    // /api/me/courses endpoint in v1.1. For now the desktop player + mobile
    // both fetch the licensed-keys bundle to drive the library list.
    return this.request<Course[]>("/api/admin/courses");
  }

  async listCourseVideos(courseId: string): Promise<CourseVideo[]> {
    return this.request<CourseVideo[]>(`/api/admin/courses/${courseId}/videos`);
  }

  // ── Tenant branding (read-only for students) ─────────────────────────

  async getBranding(): Promise<TenantBranding> {
    return this.request<TenantBranding>("/api/admin/tenant/branding");
  }

  // ── Watch heartbeat ──────────────────────────────────────────────────

  async sendHeartbeat(body: {
    video_id: string;
    position_ms: number;
    watched_delta_ms: number;
    course_id?: string | null;
  }): Promise<void> {
    await this.request("/api/watch-events/heartbeat", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

export const api = new ApiClient();
