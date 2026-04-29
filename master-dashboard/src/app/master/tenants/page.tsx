"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  type TenantCreateResponse,
  type TenantSummary,
} from "@/lib/api";

function formatDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function formatRel(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Stats tile shown at the top of the page. */
function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "primary" | "success" | "error";
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "error"
      ? "text-error"
      : "text-primary";
  return (
    <div className="rounded-xl border border-border bg-bg-surface px-5 py-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold ${toneClass}`}>{value}</div>
    </div>
  );
}

export default function TenantsPage() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");

  // Credentials "shown once" panel after a successful create
  const [justCreated, setJustCreated] = useState<TenantCreateResponse | null>(
    null
  );

  // Per-row action loading state
  const [acting, setActing] = useState<string | null>(null);

  // Delete-confirm modal
  const [deleteTarget, setDeleteTarget] = useState<TenantSummary | null>(null);
  const [deleteSlugInput, setDeleteSlugInput] = useState("");

  // Edit-quotas modal — covers encryptor seats AND student/video/course caps.
  const [seatsTarget, setSeatsTarget] = useState<TenantSummary | null>(null);
  const [seatsInput, setSeatsInput] = useState<number>(1);
  const [studentsInput, setStudentsInput] = useState<number>(50);
  const [videosInput, setVideosInput] = useState<number>(100);
  const [coursesInput, setCoursesInput] = useState<number>(20);
  const [tierInput, setTierInput] = useState<string>("Free");
  const [priceInput, setPriceInput] = useState<number>(0); // rupees

  // Encryptor-devices drawer (master-only deregister flow).
  const [encryptorsTarget, setEncryptorsTarget] =
    useState<TenantSummary | null>(null);

  // Suspend-with-reason modal
  const [suspendTarget, setSuspendTarget] = useState<TenantSummary | null>(null);
  const [suspendReason, setSuspendReason] = useState("");

  // Impersonation token modal — shown after the master clicks "Impersonate"
  const [impersonationToken, setImpersonationToken] = useState<{
    token: string;
    email: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.listTenants();
      setTenants(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tenants");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Derived stats for the header tiles
  const totalTenants = tenants.length;
  const activeTenants = tenants.filter((t) => t.is_active).length;
  const suspendedTenants = totalTenants - activeTenants;
  const totalStudents = tenants.reduce((n, t) => n + t.student_count, 0);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setCreating(true);
    try {
      const result = await api.createTenant({
        name,
        slug,
        admin_email: adminEmail,
        admin_password: adminPassword,
      });
      setJustCreated(result);
      setShowCreate(false);
      // Reset form
      setName("");
      setSlug("");
      setAdminEmail("");
      setAdminPassword("");
      // Refresh list
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create tenant");
    } finally {
      setCreating(false);
    }
  };

  const handleSuspend = async (t: TenantSummary, reason: string) => {
    setActing(t.id);
    setError("");
    try {
      await api.suspendTenant(t.id, reason);
      setTenants((prev) =>
        prev.map((x) =>
          x.id === t.id
            ? {
                ...x,
                is_active: false,
                suspended_at: new Date().toISOString(),
                suspension_reason: reason || null,
              }
            : x
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Suspend failed");
    } finally {
      setActing(null);
    }
  };

  const handleReactivate = async (t: TenantSummary) => {
    setActing(t.id);
    setError("");
    try {
      await api.reactivateTenant(t.id);
      setTenants((prev) =>
        prev.map((x) =>
          x.id === t.id ? { ...x, is_active: true, suspended_at: null } : x
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reactivate failed");
    } finally {
      setActing(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setActing(deleteTarget.id);
    setError("");
    try {
      await api.deleteTenant(deleteTarget.id, deleteSlugInput);
      setTenants((prev) => prev.filter((x) => x.id !== deleteTarget.id));
      setDeleteTarget(null);
      setDeleteSlugInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setActing(null);
    }
  };

  const handleSaveSeats = async () => {
    if (!seatsTarget) return;
    setActing(seatsTarget.id);
    setError("");
    try {
      // Send only the fields that actually changed — server treats nulls
      // as "leave this cap alone", so sending all four every time would
      // bypass the partial-update semantic.
      const limits: {
        max_encryptor_devices?: number;
        max_students?: number;
        max_videos?: number;
        max_courses?: number;
        tier?: string;
        monthly_price_cents?: number;
      } = {};
      if (seatsInput !== seatsTarget.encryptor_seats_total)
        limits.max_encryptor_devices = seatsInput;
      if (studentsInput !== seatsTarget.students_total)
        limits.max_students = studentsInput;
      if (videosInput !== seatsTarget.videos_total)
        limits.max_videos = videosInput;
      if (coursesInput !== seatsTarget.courses_total)
        limits.max_courses = coursesInput;
      if (tierInput !== seatsTarget.tier) limits.tier = tierInput;
      const priceCents = Math.round(priceInput * 100);
      if (priceCents !== seatsTarget.monthly_price_cents)
        limits.monthly_price_cents = priceCents;

      if (Object.keys(limits).length === 0) {
        setSeatsTarget(null);
        return;
      }

      await api.updateTenantLimits(seatsTarget.id, limits);
      setTenants((prev) =>
        prev.map((x) =>
          x.id === seatsTarget.id
            ? {
                ...x,
                encryptor_seats_total: seatsInput,
                students_total: studentsInput,
                videos_total: videosInput,
                courses_total: coursesInput,
              }
            : x,
        ),
      );
      setSeatsTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setActing(null);
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Tenants</h1>
          <p className="mt-1 text-sm text-text-muted">
            Every institute using the platform. Create, suspend, reactivate, or
            delete them here.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 4.5v15m7.5-7.5h-15"
            />
          </svg>
          Create Tenant
        </button>
      </div>

      {/* Platform-wide stats */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Total Tenants" value={totalTenants} />
        <StatTile label="Active" value={activeTenants} tone="success" />
        <StatTile
          label="Suspended"
          value={suspendedTenants}
          tone={suspendedTenants > 0 ? "error" : "primary"}
        />
        <StatTile label="Total Students" value={totalStudents} />
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-4 rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          {error}
          <button
            onClick={() => setError("")}
            className="ml-2 font-semibold hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}

      {/* Empty state */}
      {!loading && tenants.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-bg-surface py-20">
          <svg
            className="mb-4 h-16 w-16 text-text-muted/30"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21"
            />
          </svg>
          <p className="text-lg font-medium text-text-muted">No tenants yet</p>
          <p className="mt-1 text-sm text-text-muted/70">
            Create the first tenant to get started
          </p>
        </div>
      )}

      {/* Tenants table */}
      {!loading && tenants.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-bg-surface">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Tenant
                </th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Slug
                </th>
                <th className="px-5 py-3.5 text-center text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Students
                </th>
                <th className="px-5 py-3.5 text-center text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Videos
                </th>
                <th className="px-5 py-3.5 text-center text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Devices
                </th>
                <th className="px-5 py-3.5 text-center text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Encryptor Seats
                </th>
                <th className="px-5 py-3.5 text-center text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Status
                </th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Tier
                </th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Storage
                </th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Last login
                </th>
                <th className="px-5 py-3.5 text-right text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tenants.map((t) => {
                const busy = acting === t.id;
                return (
                  <tr
                    key={t.id}
                    className="transition-colors hover:bg-bg-surface-hover"
                  >
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-xs font-bold text-primary">
                          {t.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className="text-sm font-medium text-text-primary">
                            {t.name}
                          </div>
                          <div className="text-xs text-text-muted font-mono">
                            {t.id.slice(0, 8)}…
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <code className="rounded bg-bg-primary px-2 py-1 text-xs text-text-muted font-mono">
                        {t.slug}
                      </code>
                    </td>
                    <td className="px-5 py-4 text-center text-sm text-text-primary">
                      {t.student_count}
                    </td>
                    <td className="px-5 py-4 text-center text-sm text-text-primary">
                      {t.video_count}
                    </td>
                    <td className="px-5 py-4 text-center text-sm text-text-primary">
                      {t.active_device_count}
                    </td>
                    <td className="px-5 py-4 text-center">
                      <button
                        onClick={() => {
                          setSeatsTarget(t);
                          setSeatsInput(t.encryptor_seats_total);
                          setStudentsInput(t.students_total);
                          setVideosInput(t.videos_total);
                          setCoursesInput(t.courses_total);
                          setTierInput(t.tier);
                          setPriceInput(t.monthly_price_cents / 100);
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-mono text-text-primary transition-colors hover:bg-bg-surface-hover"
                        title="Click to edit the seat cap"
                      >
                        {t.encryptor_seats_used} / {t.encryptor_seats_total}
                      </button>
                    </td>
                    <td className="px-5 py-4 text-center">
                      <span
                        className={`inline-flex rounded-md px-2.5 py-1 text-xs font-semibold ${
                          t.is_active
                            ? "bg-success/10 text-success"
                            : "bg-error/10 text-error"
                        }`}
                      >
                        {t.is_active ? "Active" : "Suspended"}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm">
                      <div className="text-text-primary">{t.tier}</div>
                      {t.monthly_price_cents > 0 && (
                        <div className="text-xs text-text-muted">
                          ₹{(t.monthly_price_cents / 100).toFixed(0)}/mo
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-4 text-sm text-text-muted">
                      {formatBytes(t.total_storage_bytes)}
                    </td>
                    <td className="px-5 py-4 text-sm text-text-muted">
                      {formatRel(t.last_admin_login_at)}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setEncryptorsTarget(t)}
                          disabled={busy}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-bg-surface-hover disabled:opacity-50"
                        >
                          Encryptors
                        </button>
                        <button
                          onClick={async () => {
                            setActing(t.id);
                            setError("");
                            try {
                              const r = await api.impersonateTenantAdmin(t.id);
                              setImpersonationToken({
                                token: r.access_token,
                                email: r.impersonating_email,
                              });
                            } catch (err) {
                              setError(
                                err instanceof Error
                                  ? err.message
                                  : "Impersonation failed",
                              );
                            } finally {
                              setActing(null);
                            }
                          }}
                          disabled={busy}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
                        >
                          Impersonate
                        </button>
                        {t.is_active ? (
                          <button
                            onClick={() => {
                              setSuspendTarget(t);
                              setSuspendReason("");
                            }}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-warning/30 px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/10 disabled:opacity-50"
                          >
                            {busy ? "…" : "Suspend"}
                          </button>
                        ) : (
                          <button
                            onClick={() => handleReactivate(t)}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-success/30 px-3 py-1.5 text-xs font-medium text-success transition-colors hover:bg-success/10 disabled:opacity-50"
                          >
                            {busy ? "…" : "Reactivate"}
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setDeleteTarget(t);
                            setDeleteSlugInput("");
                          }}
                          disabled={busy}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-error/30 px-3 py-1.5 text-xs font-medium text-error transition-colors hover:bg-error/10 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── Create Tenant Modal ─── */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-bg-surface p-6">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-lg font-bold text-text-primary">
                Create Tenant
              </h2>
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-lg p-1 text-text-muted transition-colors hover:bg-bg-surface-hover"
                disabled={creating}
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-muted">
                  Tenant name
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Academy"
                  className="w-full rounded-lg border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder-text-muted/50 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-muted">
                  Slug
                </label>
                <input
                  type="text"
                  required
                  value={slug}
                  onChange={(e) =>
                    setSlug(
                      e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")
                    )
                  }
                  placeholder="acme-academy"
                  pattern="^[a-z0-9][a-z0-9-]*$"
                  className="w-full rounded-lg border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder-text-muted/50 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
                />
                <p className="mt-1 text-xs text-text-muted/70">
                  URL-safe: lowercase letters, digits, and hyphens only.
                </p>
              </div>

              <div className="pt-2 border-t border-border" />

              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-muted">
                  First admin email
                </label>
                <input
                  type="email"
                  required
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="admin@acme.com"
                  className="w-full rounded-lg border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder-text-muted/50 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-muted">
                  Admin password
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full rounded-lg border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder-text-muted/50 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  disabled={creating}
                  className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-text-muted transition-colors hover:bg-bg-surface-hover disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
                >
                  {creating ? "Creating…" : "Create Tenant"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── "Shown Once" Credentials Panel ─── */}
      {justCreated && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-lg rounded-xl border border-primary/40 bg-bg-surface p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/10">
                <svg
                  className="h-6 w-6 text-success"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-bold text-text-primary">
                  Tenant created
                </h2>
                <p className="text-xs text-text-muted">
                  Save the master key now — it won&rsquo;t be shown again.
                </p>
              </div>
            </div>

            <div className="space-y-3 text-sm">
              <Field label="Tenant" value={justCreated.tenant_name} />
              <Field label="Slug" value={justCreated.tenant_slug} mono />
              <Field
                label="Admin email"
                value={justCreated.admin_email}
                mono
              />
              <Field
                label="Master key (hex)"
                value={justCreated.master_key_hex}
                mono
                danger
              />
            </div>

            <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-xs text-warning">
              ⚠️ Back up the master key in a password manager AND on paper. If
              <code className="mx-1 rounded bg-bg-primary px-1 py-0.5 font-mono">
                SERVER_ENCRYPTION_KEY
              </code>
              is ever lost, this hex string is the only way to recover this
              tenant&rsquo;s encrypted videos.
            </div>

            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setJustCreated(null)}
                className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
              >
                I&rsquo;ve saved it — close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Encryptors Drawer (master deregister) ─── */}
      {encryptorsTarget && (
        <EncryptorsDrawer
          tenant={encryptorsTarget}
          onClose={() => setEncryptorsTarget(null)}
          onChanged={load}
        />
      )}

      {/* ─── Suspend with reason modal ─── */}
      {suspendTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => setSuspendTarget(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-warning/40 bg-bg-surface p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-1 text-lg font-bold text-text-primary">
              Suspend {suspendTarget.name}?
            </h2>
            <p className="mb-4 text-xs text-text-muted">
              All API access stops immediately. Students already in offline
              mode keep playing for the grace period (default 20 days). The
              reason below is shown to the tenant admin on next login attempt.
            </p>
            <label className="mb-1.5 block text-sm font-medium text-text-muted">
              Reason (shown to tenant)
            </label>
            <textarea
              rows={3}
              autoFocus
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              placeholder="e.g. Payment overdue. Contact billing@..."
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-warning focus:ring-1 focus:ring-warning"
            />
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setSuspendTarget(null)}
                disabled={acting === suspendTarget.id}
                className="flex-1 rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-muted hover:bg-bg-surface-hover disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  await handleSuspend(suspendTarget, suspendReason);
                  setSuspendTarget(null);
                  setSuspendReason("");
                }}
                disabled={acting === suspendTarget.id}
                className="flex-1 rounded-lg bg-warning px-4 py-2 text-sm font-semibold text-white hover:bg-warning/90 disabled:opacity-50"
              >
                {acting === suspendTarget.id ? "Suspending…" : "Suspend"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Impersonation token modal ─── */}
      {impersonationToken && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => setImpersonationToken(null)}
        >
          <div
            className="w-full max-w-xl rounded-xl border border-primary/40 bg-bg-surface p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-1 text-lg font-bold text-text-primary">
              Impersonation token issued
            </h2>
            <p className="mb-3 text-xs text-text-muted">
              15-minute access token for{" "}
              <span className="font-mono text-text-primary">
                {impersonationToken.email}
              </span>
              . Use it to debug a tenant's issue. Audit-logged.
            </p>
            <p className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              Paste this token into the encryptor app's{" "}
              <code>localStorage.access_token</code> via DevTools to act as
              that admin. UI helpers for one-click impersonation come in v1.6.
            </p>
            <code className="mb-4 block max-h-40 overflow-auto break-all rounded-md border border-border bg-bg-primary p-3 font-mono text-xs text-text-primary">
              {impersonationToken.token}
            </code>
            <div className="flex gap-3">
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      impersonationToken.token,
                    );
                  } catch {
                    /* no clipboard, no fallback — token is selectable */
                  }
                }}
                className="flex-1 rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-muted hover:bg-bg-surface-hover"
              >
                Copy
              </button>
              <button
                onClick={() => setImpersonationToken(null)}
                className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Edit Quotas Modal — encryptor seats + student/video/course caps ─── */}
      {seatsTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-bg-surface p-6">
            <div className="mb-4">
              <h2 className="text-lg font-bold text-text-primary">
                Resource quotas
              </h2>
              <p className="mt-1 text-xs text-text-muted">
                {seatsTarget.name} ·{" "}
                <span className="font-mono">{seatsTarget.slug}</span>
              </p>
            </div>

            <QuotaRow
              label="Encryptor seats"
              used={seatsTarget.encryptor_seats_used}
              value={seatsInput}
              onChange={setSeatsInput}
              min={1}
              max={100}
              floor={seatsTarget.encryptor_seats_used}
            />
            <QuotaRow
              label="Students"
              used={seatsTarget.student_count}
              value={studentsInput}
              onChange={setStudentsInput}
              min={0}
              max={100000}
              floor={seatsTarget.student_count}
            />
            <QuotaRow
              label="Videos"
              used={seatsTarget.video_count}
              value={videosInput}
              onChange={setVideosInput}
              min={0}
              max={100000}
              floor={seatsTarget.video_count}
            />
            <QuotaRow
              label="Courses"
              used={seatsTarget.course_count}
              value={coursesInput}
              onChange={setCoursesInput}
              min={0}
              max={100000}
              floor={seatsTarget.course_count}
            />

            {/* Tier + price — same modal, no separate flow needed since
                they go through the same /limits endpoint */}
            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-text-muted">
                  Tier label
                </label>
                <input
                  type="text"
                  value={tierInput}
                  onChange={(e) => setTierInput(e.target.value)}
                  placeholder="Free / Starter / Pro / Custom"
                  className="w-full rounded-lg border border-border bg-bg-primary px-4 py-2 text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-text-muted">
                  Monthly price (₹)
                </label>
                <input
                  type="number"
                  min={0}
                  value={priceInput}
                  onChange={(e) =>
                    setPriceInput(parseFloat(e.target.value) || 0)
                  }
                  className="w-full rounded-lg border border-border bg-bg-primary px-4 py-2 text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            <p className="mt-3 text-xs text-text-muted/70">
              Caps below current usage are rejected — ask the tenant to
              archive resources first if you want to downsize.
            </p>

            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setSeatsTarget(null)}
                disabled={acting === seatsTarget.id}
                className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-text-muted transition-colors hover:bg-bg-surface-hover disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveSeats}
                disabled={
                  acting === seatsTarget.id ||
                  seatsInput < seatsTarget.encryptor_seats_used ||
                  studentsInput < seatsTarget.student_count ||
                  videosInput < seatsTarget.video_count ||
                  coursesInput < seatsTarget.course_count
                }
                className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
              >
                {acting === seatsTarget.id ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Delete Confirmation Modal ─── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md rounded-xl border border-error/40 bg-bg-surface p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-error/10">
                <svg
                  className="h-6 w-6 text-error"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
                  />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-bold text-text-primary">
                  Delete tenant?
                </h2>
                <p className="text-xs text-text-muted">
                  This is permanent and irreversible.
                </p>
              </div>
            </div>

            <p className="mb-4 text-sm text-text-muted">
              All of{" "}
              <span className="font-semibold text-text-primary">
                {deleteTarget.name}
              </span>
              &rsquo;s data will be erased: {deleteTarget.student_count}{" "}
              students, {deleteTarget.video_count} videos, {deleteTarget.active_device_count}{" "}
              devices, plus every license and audit log. Consider{" "}
              <em>Suspend</em> instead unless this is a GDPR / DPDP erasure
              request.
            </p>

            <label className="mb-1.5 block text-sm font-medium text-text-muted">
              Type{" "}
              <code className="rounded bg-bg-primary px-1.5 py-0.5 font-mono text-error">
                {deleteTarget.slug}
              </code>{" "}
              to confirm:
            </label>
            <input
              type="text"
              value={deleteSlugInput}
              onChange={(e) => setDeleteSlugInput(e.target.value)}
              placeholder={deleteTarget.slug}
              className="w-full rounded-lg border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder-text-muted/50 outline-none transition-colors focus:border-error focus:ring-1 focus:ring-error"
              autoFocus
            />

            <div className="mt-5 flex gap-3">
              <button
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteSlugInput("");
                }}
                disabled={acting === deleteTarget.id}
                className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-text-muted transition-colors hover:bg-bg-surface-hover disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={
                  deleteSlugInput !== deleteTarget.slug ||
                  acting === deleteTarget.id
                }
                className="flex-1 rounded-lg bg-error px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-error/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {acting === deleteTarget.id
                  ? "Deleting…"
                  : "Permanently delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Small labeled read-only field used in the "just created" panel. */
function Field({
  label,
  value,
  mono,
  danger,
}: {
  label: string;
  value: string;
  mono?: boolean;
  danger?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // silent — user can just select manually
    }
  };

  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <code
          className={`flex-1 overflow-x-auto rounded-lg border px-3 py-2 text-xs ${
            mono ? "font-mono" : ""
          } ${
            danger
              ? "border-error/30 bg-error/5 text-error"
              : "border-border bg-bg-primary text-text-primary"
          }`}
        >
          {value}
        </code>
        <button
          onClick={handleCopy}
          className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-bg-surface-hover"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** Slide-over drawer listing a tenant's encryptor devices with master-only
 *  deregister buttons. The tenant-admin app no longer has these — the policy
 *  is "platform owner controls who holds the master key". */
function EncryptorsDrawer({
  tenant,
  onClose,
  onChanged,
}: {
  tenant: TenantSummary;
  onClose: () => void;
  onChanged: () => void;
}) {
  type Device = {
    id: string;
    fingerprint: string;
    hostname: string;
    os_version: string;
    is_active: boolean;
    last_seen_at: string;
    last_master_key_fetch_at: string;
  };
  const [data, setData] = useState<{
    seats_used: number;
    seats_total: number;
    devices: Device[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listTenantEncryptors(tenant.id);
      setData({
        seats_used: r.seats_used,
        seats_total: r.seats_total,
        devices: r.devices,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [tenant.id]);

  useEffect(() => {
    load();
  }, [load]);

  const dereg = async (id: string, hostname: string) => {
    if (
      !confirm(
        `Deregister "${hostname || id}"? Frees the seat. The encryptor app on that device will fail to load the master key on its next launch.`,
      )
    ) {
      return;
    }
    setActing(id);
    try {
      await api.deregisterTenantEncryptor(tenant.id, id);
      await load();
      onChanged(); // refresh the parent tenants list (seat count etc)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deregister failed");
    } finally {
      setActing(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-y-auto bg-bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-text-primary">
              Encryptor devices · {tenant.name}
            </h2>
            <p className="text-xs text-text-muted">
              Deregister revokes a device's ability to fetch the master key on
              next launch. Audit-logged.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1 text-sm text-text-muted hover:bg-bg-surface-hover"
          >
            Close
          </button>
        </div>

        {error && (
          <p className="mb-3 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {error}
          </p>
        )}

        {data && (
          <p className="mb-4 text-sm text-text-muted">
            <span className="font-mono text-text-primary">
              {data.seats_used} / {data.seats_total}
            </span>{" "}
            seats in use
          </p>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : !data || data.devices.length === 0 ? (
          <p className="rounded-xl border border-border bg-bg-primary py-10 text-center text-sm text-text-muted">
            No encryptor devices registered for this tenant.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-bg-primary text-xs uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Device</th>
                  <th className="px-3 py-2 text-left">Last seen</th>
                  <th className="px-3 py-2 text-center">Status</th>
                  <th className="px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-bg-surface">
                {data.devices.map((d) => (
                  <tr key={d.id} className="hover:bg-bg-surface-hover">
                    <td className="px-3 py-2">
                      <div className="text-text-primary">
                        {d.hostname || "(unnamed)"}
                      </div>
                      <div className="font-mono text-xs text-text-muted">
                        {d.fingerprint} · {d.os_version}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-text-muted">
                      {new Date(d.last_seen_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${
                          d.is_active
                            ? "bg-success/10 text-success"
                            : "bg-error/10 text-error"
                        }`}
                      >
                        {d.is_active ? "active" : "deregistered"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {d.is_active && (
                        <button
                          onClick={() => dereg(d.id, d.hostname)}
                          disabled={acting === d.id}
                          className="rounded-md border border-error/30 px-2.5 py-1 text-xs text-error hover:bg-error/10 disabled:opacity-50"
                        >
                          {acting === d.id ? "…" : "Deregister"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** Single quota row in the edit-quotas modal. Shows current usage so the
 *  master can't accidentally set a cap below it (the disabled-Save guard
 *  in the parent modal enforces this). */
function QuotaRow({
  label,
  used,
  value,
  onChange,
  min,
  max,
  floor,
}: {
  label: string;
  used: number;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  floor: number;
}) {
  const tooLow = value < floor;
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline justify-between">
        <label className="text-sm font-medium text-text-muted">{label}</label>
        <span className="text-xs text-text-muted/70">
          using {used} of {value}
        </span>
      </div>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) =>
          onChange(Math.max(min, parseInt(e.target.value, 10) || min))
        }
        className={`w-full rounded-lg border bg-bg-primary px-4 py-2 text-sm text-text-primary outline-none focus:ring-1 ${
          tooLow
            ? "border-error focus:border-error focus:ring-error"
            : "border-border focus:border-primary focus:ring-primary"
        }`}
      />
      {tooLow && (
        <p className="mt-1 text-xs text-error">
          Below current usage ({used}). Ask the tenant to archive items first.
        </p>
      )}
    </div>
  );
}
