"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Row {
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
}

export default function MasterAuditPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [actionFilter, setActionFilter] = useState("");
  const [tenantFilter, setTenantFilter] = useState("");
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.masterAudit({
        action: actionFilter || undefined,
        tenant_id: tenantFilter || undefined,
        since_days: days,
        limit: 200,
      });
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, [actionFilter, tenantFilter, days]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Audit log</h1>
        <p className="mt-1 text-sm text-text-muted">
          Cross-tenant audit. Append-only. Filter by action prefix
          (<code>course.*</code>) or tenant.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <input
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          placeholder="Action filter (e.g. encryptor.* or master.totp_disable)"
          className="rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text-primary"
        />
        <input
          value={tenantFilter}
          onChange={(e) => setTenantFilter(e.target.value)}
          placeholder='Tenant UUID, or "system" for platform-level only'
          className="rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text-primary"
        />
        <select
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value, 10))}
          className="rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text-primary"
        >
          <option value={1}>Last 24h</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {error && (
        <p className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-border bg-bg-surface py-10 text-center text-sm text-text-muted">
          No entries match these filters.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-xs">
            <thead className="bg-bg-surface uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-left">Actor</th>
                <th className="px-3 py-2 text-left">Action</th>
                <th className="px-3 py-2 text-left">Tenant</th>
                <th className="px-3 py-2 text-left">Target</th>
                <th className="px-3 py-2 text-left">IP</th>
                <th className="px-3 py-2 text-left">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-bg-primary">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-bg-surface-hover">
                  <td className="px-3 py-2 text-text-muted">
                    {new Date(r.occurred_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-text-primary">
                    {r.actor_email ?? r.actor_type}
                  </td>
                  <td className="px-3 py-2 font-mono text-success">
                    {r.action}
                  </td>
                  <td className="px-3 py-2 text-text-muted">
                    {r.tenant_id ? r.tenant_id.slice(0, 8) : "system"}
                  </td>
                  <td className="px-3 py-2 text-text-muted">
                    {r.target_type
                      ? `${r.target_type}:${(r.target_id ?? "").slice(0, 8)}`
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-text-muted">
                    {r.ip_address ?? "—"}
                  </td>
                  <td className="px-3 py-2 max-w-md truncate font-mono text-text-muted">
                    {Object.keys(r.details).length > 0
                      ? JSON.stringify(r.details)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
