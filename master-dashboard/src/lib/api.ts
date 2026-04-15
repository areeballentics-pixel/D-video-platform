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
  created_at: string;
  student_count: number;
  admin_count: number;
  video_count: number;
  active_device_count: number;
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

  async login(email: string, password: string): Promise<MasterLoginResponse> {
    const res = await fetch(`${API_BASE}/api/master/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
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

  async suspendTenant(tenantId: string): Promise<TenantActionResponse> {
    return this.request<TenantActionResponse>(
      `/api/master/tenants/${tenantId}/suspend`,
      { method: "PATCH" }
    );
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
}

export const api = new MasterApiClient();
