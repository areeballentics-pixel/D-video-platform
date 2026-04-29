import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/rest";

interface EncryptorDevice {
  id: string;
  fingerprint: string;
  hostname: string;
  os_version: string;
  is_active: boolean;
  registered_at: string;
  last_seen_at: string;
  last_master_key_fetch_at: string;
}

interface EncryptorList {
  devices: EncryptorDevice[];
  seats_used: number;
  seats_total: number;
}

export default function EncryptorsPage() {
  const [data, setData] = useState<EncryptorList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showRequest, setShowRequest] = useState(false);
  const [requestSeats, setRequestSeats] = useState(2);
  const [requestNotes, setRequestNotes] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [requestSent, setRequestSent] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiGet<EncryptorList>("/api/admin/encryptors"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const submitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setRequesting(true);
    try {
      await apiPost("/api/admin/encryptors/seat-upgrade-request", {
        requested_seats: requestSeats,
        notes: requestNotes,
      });
      setRequestSent(true);
      setShowRequest(false);
      setRequestNotes("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Encryptor devices</h1>
          <p className="mt-1 text-sm text-slate-400">
            Each registered desktop install. To deregister a device or free up
            seats, contact the platform team.
          </p>
        </div>
        {data && (
          <button
            onClick={() => setShowRequest(true)}
            disabled={data.seats_used < data.seats_total}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
            title={
              data.seats_used < data.seats_total
                ? "You still have seats available"
                : "Ask the platform team for more"
            }
          >
            Request more seats
          </button>
        )}
      </div>

      {requestSent && (
        <div className="rounded-md border border-emerald-700/40 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
          Request submitted. The platform team will review and update your cap.
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {data && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <p className="text-xs text-slate-400">Seat usage</p>
          <p className="mt-1 text-3xl font-bold">
            {data.seats_used}{" "}
            <span className="text-base font-medium text-slate-400">
              of {data.seats_total} used
            </span>
          </p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full bg-primary"
              style={{
                width: `${
                  data.seats_total > 0
                    ? Math.min(100, (data.seats_used / data.seats_total) * 100)
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : !data || data.devices.length === 0 ? (
        <p className="rounded-2xl border border-slate-800 bg-slate-900 py-10 text-center text-sm text-slate-500">
          No encryptor devices registered yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-2.5 text-left">Device</th>
                <th className="px-4 py-2.5 text-left">OS</th>
                <th className="px-4 py-2.5 text-left">Last seen</th>
                <th className="px-4 py-2.5 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-950">
              {data.devices.map((d) => (
                <tr key={d.id} className="hover:bg-slate-900">
                  <td className="px-4 py-2.5">
                    <div>{d.hostname || "(unnamed)"}</div>
                    <div className="font-mono text-xs text-slate-500">
                      {d.fingerprint}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-400">{d.os_version}</td>
                  <td className="px-4 py-2.5 text-slate-400">
                    {new Date(d.last_seen_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        d.is_active
                          ? "bg-emerald-700/40 text-emerald-200"
                          : "bg-red-700/40 text-red-200"
                      }`}
                    >
                      {d.is_active ? "active" : "deregistered"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showRequest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={submitRequest}
            className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6"
          >
            <h2 className="mb-2 text-lg font-bold">Request more seats</h2>
            <p className="mb-4 text-xs text-slate-400">
              The platform team reviews and bumps your cap.
            </p>

            <label className="mb-1.5 block text-sm text-slate-400">
              How many seats?
            </label>
            <input
              type="number"
              min={(data?.seats_total ?? 1) + 1}
              max={50}
              value={requestSeats}
              onChange={(e) =>
                setRequestSeats(parseInt(e.target.value, 10) || 1)
              }
              className="mb-3 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              required
            />

            <label className="mb-1.5 block text-sm text-slate-400">
              Notes (optional)
            </label>
            <textarea
              rows={3}
              value={requestNotes}
              onChange={(e) => setRequestNotes(e.target.value)}
              placeholder="e.g. Hiring 3 content editors next month."
              className="mb-4 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowRequest(false)}
                className="flex-1 rounded-md border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={requesting}
                className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {requesting ? "Sending…" : "Send request"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
