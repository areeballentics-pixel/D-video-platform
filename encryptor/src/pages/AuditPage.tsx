import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/rest";

interface AuditEntry {
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

export default function AuditPage() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        since_days: String(days),
        limit: "200",
      });
      if (actionFilter) params.set("action", actionFilter);
      const data = await apiGet<AuditEntry[]>(
        `/api/admin/audit?${params.toString()}`,
      );
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, [actionFilter, days]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Audit log</h1>
        <p className="mt-1 text-sm text-slate-400">
          Sensitive admin actions. Append-only. Useful for compliance + debugging.
        </p>
      </div>

      <div className="flex gap-3">
        <input
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          placeholder="Filter by action (e.g. encryptor.* or course.publish)"
          className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
        />
        <select
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value, 10))}
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
        >
          <option value={1}>Last 24h</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {error && (
        <p className="rounded-md border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-2xl border border-slate-800 bg-slate-900 py-10 text-center text-sm text-slate-500">
          No audit entries in this window.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-800">
          <table className="w-full text-xs">
            <thead className="bg-slate-900 uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-left">Actor</th>
                <th className="px-3 py-2 text-left">Action</th>
                <th className="px-3 py-2 text-left">Target</th>
                <th className="px-3 py-2 text-left">IP</th>
                <th className="px-3 py-2 text-left">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-950">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-900">
                  <td className="px-3 py-2 text-slate-400">
                    {new Date(r.occurred_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    {r.actor_email ?? r.actor_type}
                  </td>
                  <td className="px-3 py-2 font-mono text-emerald-300">
                    {r.action}
                  </td>
                  <td className="px-3 py-2 text-slate-400">
                    {r.target_type ? `${r.target_type}:${(r.target_id ?? "").slice(0, 8)}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-500">
                    {r.ip_address ?? "—"}
                  </td>
                  <td className="px-3 py-2 max-w-md truncate font-mono text-slate-500">
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
