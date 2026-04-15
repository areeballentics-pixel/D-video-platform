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

  const handleSuspend = async (t: TenantSummary) => {
    setActing(t.id);
    setError("");
    try {
      await api.suspendTenant(t.id);
      setTenants((prev) =>
        prev.map((x) =>
          x.id === t.id
            ? {
                ...x,
                is_active: false,
                suspended_at: new Date().toISOString(),
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
                  Status
                </th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Created
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
                    <td className="px-5 py-4 text-sm text-text-muted">
                      {formatDate(t.created_at)}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center justify-end gap-2">
                        {t.is_active ? (
                          <button
                            onClick={() => handleSuspend(t)}
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
