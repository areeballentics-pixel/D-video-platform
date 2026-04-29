// API client for the Master (platform-admin) dashboard.
//
// Token storage is keyed differently from the tenant dashboard
// (master_access_token, master_refresh_token) so the two dashboards
// can even run side-by-side in the same browser without clashing.

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ── Types ───────────────────────────────────────────────────────────────────

export interface MasterLoginResponse {
  access_token: string;
  refresh_token: string;
  admin_id: string;
  email: string;
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  suspended_at: string | null;
  suspension_reason: string | null;
  created_at: string;
  student_count: number;
  admin_count: number;
  video_count: number;
  course_count: number;
  active_device_count: number;
  encryptor_seats_used: number;
  encryptor_seats_total: number;
  students_total: number;
  videos_total: number;
  courses_total: number;
  // v1.5
  tier: string;
  monthly_price_cents: number;
  last_admin_login_at: string | null;
  total_storage_bytes: number;
  new_students_30d: number;
  new_videos_30d: number;
  new_courses_30d: number;
}

export interface TenantCreateResponse {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  master_key_hex: string;
  admin_user_id: string;
  admin_email: string;
}

export interface TenantActionResponse {
  tenant_id: string;
  is_active: boolean;
  message: string;
}

export interface PlatformStats {
  total_tenants: number;
  active_tenants: number;
  suspended_tenants: number;
  total_users: number;
  total_admins: number;
  total_students: number;
  total_videos: number;
  total_courses: number;
  total_active_enrollments: number;
  total_encryptor_devices: number;
  pending_seat_upgrades: number;
}

export interface SeatUpgradeRequest {
  id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  requested_by_email: string | null;
  requested_seats: number;
  current_seats: number;
  status: "pending" | "fulfilled" | "rejected";
  notes: string;
  requested_at: string;
  handled_at: string | null;
  handled_notes: string | null;
}

export interface AuditEntry {
  id: string;
  actor_type: string;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  ip_address: string | null;
  occurred_at: string;
}

export interface TotpEnableResponse {
  secret: string;
  provisioning_uri: string;
}

export class TotpRequiredError extends Error {
  constructor() {
    super("TOTP code required");
    this.name = "TotpRequiredError";
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

class MasterApiClient {
  private getToken(): string | null {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("master_access_token");
  }

  setToken(token: string): void {
    localStorage.setItem("master_access_token", token);
  }

  setRefreshToken(token: string): void {
    localStorage.setItem("master_refresh_token", token);
  }

  getRefreshToken(): string | null {
    return localStorage.getItem("master_refresh_token");
  }

  clearToken(): void {
    localStorage.removeItem("master_access_token");
    localStorage.removeItem("master_refresh_token");
    localStorage.removeItem("master_email");
    localStorage.removeItem("master_admin_id");
  }

  isAuthenticated(): boolean {
    return !!this.getToken();
  }

  getEmail(): string {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("master_email") ?? "";
  }

  private async tryRefresh(): Promise<boolean> {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API_BASE}/api/master/refresh`, {
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
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (!(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }

    const doFetch = () =>
      fetch(`${API_BASE}${path}`, { ...options, headers });

    let res = await doFetch();

    if (res.status === 401) {
      const ok = await this.tryRefresh();
      if (ok) {
        headers["Authorization"] = `Bearer ${this.getToken()}`;
        res = await doFetch();
      } else {
        this.clearToken();
        if (typeof window !== "undefined") {
          window.location.href = "/login";
        }
        throw new Error("Session expired. Please log in again.");
      }
    }

    if (!res.ok) {
      const body = await res.text();
      let message = `API error ${res.status}`;
      try {
        const json = JSON.parse(body);
        message = json.detail || json.message || message;
      } catch {
        // fallthrough to default
      }
      throw new Error(message);
    }

    return res.json() as Promise<T>;
  }

  // ── Auth ──────────────────────────────────────────────────────────────

  async login(
    email: string,
    password: string,
    totpCode?: string,
  ): Promise<MasterLoginResponse> {
    const res = await fetch(`${API_BASE}/api/master/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, totp_code: totpCode ?? null }),
    });
    if (!res.ok) {
      // Server signals "TOTP required" via the X-Auth-Reason header.
      // The login page intercepts this and re-prompts with a code field.
      if (res.status === 401 && res.headers.get("x-auth-reason") === "totp_required") {
        throw new TotpRequiredError();
      }
      const body = await res.text();
      let message = "Login failed";
      try {
        message = JSON.parse(body).detail ?? message;
      } catch {}
      throw new Error(message);
    }
    const data = (await res.json()) as MasterLoginResponse;
    this.setToken(data.access_token);
    this.setRefreshToken(data.refresh_token);
    localStorage.setItem("master_email", data.email);
    localStorage.setItem("master_admin_id", data.admin_id);
    return data;
  }

  async logout(): Promise<void> {
    try {
      await this.request("/api/master/logout", { method: "POST" });
    } catch {
      // best-effort
    }
    this.clearToken();
  }

  // ── Tenants ───────────────────────────────────────────────────────────

  async listTenants(): Promise<TenantSummary[]> {
    const data = await this.request<{ tenants: TenantSummary[] }>(
      "/api/master/tenants"
    );
    return data.tenants;
  }

  async createTenant(body: {
    name: string;
    slug: string;
    admin_email: string;
    admin_password: string;
  }): Promise<TenantCreateResponse> {
    return this.request<TenantCreateResponse>("/api/master/tenants", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async suspendTenant(
    tenantId: string,
    reason: string = "",
  ): Promise<TenantActionResponse> {
    return this.request<TenantActionResponse>(
      `/api/master/tenants/${tenantId}/suspend`,
      { method: "PATCH", body: JSON.stringify({ reason }) },
    );
  }

  async bulkTenantAction(
    tenantIds: string[],
    action: "suspend" | "reactivate",
    reason: string = "",
  ): Promise<{ successes: string[]; failures: Record<string, string> }> {
    return this.request("/api/master/tenants/bulk-action", {
      method: "POST",
      body: JSON.stringify({ tenant_ids: tenantIds, action, reason }),
    });
  }

  async generateRecoveryCodes(): Promise<{ codes: string[] }> {
    return this.request("/api/master/me/totp/recovery-codes", {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async impersonateTenantAdmin(
    tenantId: string,
  ): Promise<{
    access_token: string;
    expires_in: number;
    impersonating_user_id: string;
    impersonating_email: string;
    tenant_id: string;
  }> {
    return this.request(
      `/api/master/tenants/${tenantId}/impersonate`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  async masterAudit(params: {
    action?: string;
    actor_email?: string;
    tenant_id?: string;
    since_days?: number;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      tenant_id: string | null;
      actor_type: string;
      actor_email: string | null;
      action: string;
      target_type: string | null;
      target_id: string | null;
      details: Record<string, unknown>;
      ip_address: string | null;
      occurred_at: string;
    }>
  > {
    const q = new URLSearchParams();
    if (params.action) q.set("action", params.action);
    if (params.actor_email) q.set("actor_email", params.actor_email);
    if (params.tenant_id) q.set("tenant_id", params.tenant_id);
    if (params.since_days) q.set("since_days", String(params.since_days));
    if (params.limit) q.set("limit", String(params.limit));
    return this.request(`/api/master/audit?${q.toString()}`);
  }

  async reactivateTenant(tenantId: string): Promise<TenantActionResponse> {
    return this.request<TenantActionResponse>(
      `/api/master/tenants/${tenantId}/reactivate`,
      { method: "PATCH" }
    );
  }

  async deleteTenant(
    tenantId: string,
    confirmSlug: string
  ): Promise<TenantActionResponse> {
    const encoded = encodeURIComponent(confirmSlug);
    return this.request<TenantActionResponse>(
      `/api/master/tenants/${tenantId}?confirm_slug=${encoded}`,
      { method: "DELETE" }
    );
  }

  async listTenantEncryptors(
    tenantId: string,
  ): Promise<{
    tenant_id: string;
    tenant_name: string;
    seats_used: number;
    seats_total: number;
    devices: Array<{
      id: string;
      fingerprint: string;
      hostname: string;
      os_version: string;
      is_active: boolean;
      registered_at: string;
      last_seen_at: string;
      last_master_key_fetch_at: string;
    }>;
  }> {
    return this.request(`/api/master/tenants/${tenantId}/encryptors`);
  }

  async deregisterTenantEncryptor(
    tenantId: string,
    deviceId: string,
  ): Promise<TenantActionResponse> {
    return this.request<TenantActionResponse>(
      `/api/master/tenants/${tenantId}/encryptors/${deviceId}`,
      { method: "DELETE" },
    );
  }

  async updateTenantLimits(
    tenantId: string,
    limits: {
      max_encryptor_devices?: number;
      max_students?: number;
      max_videos?: number;
      max_courses?: number;
    },
  ): Promise<TenantActionResponse> {
    return this.request<TenantActionResponse>(
      `/api/master/tenants/${tenantId}/limits`,
      {
        method: "PATCH",
        body: JSON.stringify(limits),
      },
    );
  }

  // ── Platform stats ────────────────────────────────────────────────────

  async getStats(): Promise<PlatformStats> {
    return this.request<PlatformStats>("/api/master/stats");
  }

  // ── Seat upgrade requests ─────────────────────────────────────────────

  async listUpgradeRequests(
    statusFilter: "pending" | "fulfilled" | "rejected" | "all" = "pending",
  ): Promise<SeatUpgradeRequest[]> {
    return this.request<SeatUpgradeRequest[]>(
      `/api/master/upgrade-requests?status_filter=${statusFilter}`,
    );
  }

  async fulfillUpgradeRequest(
    requestId: string,
    body: { new_max_encryptor_devices?: number; handled_notes?: string },
  ): Promise<SeatUpgradeRequest> {
    return this.request<SeatUpgradeRequest>(
      `/api/master/upgrade-requests/${requestId}/fulfill`,
      {
        method: "POST",
        body: JSON.stringify({
          new_max_encryptor_devices: body.new_max_encryptor_devices ?? null,
          handled_notes: body.handled_notes ?? "",
        }),
      },
    );
  }

  async rejectUpgradeRequest(
    requestId: string,
    handledNotes: string,
  ): Promise<SeatUpgradeRequest> {
    return this.request<SeatUpgradeRequest>(
      `/api/master/upgrade-requests/${requestId}/reject`,
      {
        method: "POST",
        body: JSON.stringify({
          new_max_encryptor_devices: null,
          handled_notes: handledNotes,
        }),
      },
    );
  }

  // ── 2FA (TOTP) ────────────────────────────────────────────────────────

  async totpEnable(): Promise<TotpEnableResponse> {
    return this.request<TotpEnableResponse>("/api/master/me/totp/enable", {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async totpConfirm(code: string): Promise<{ message: string }> {
    return this.request<{ message: string }>("/api/master/me/totp/confirm", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  }

  async totpDisable(
    password: string,
    code: string,
  ): Promise<{ message: string }> {
    return this.request<{ message: string }>("/api/master/me/totp/disable", {
      method: "POST",
      body: JSON.stringify({ password, code }),
    });
  }
}

export const api = new MasterApiClient();
