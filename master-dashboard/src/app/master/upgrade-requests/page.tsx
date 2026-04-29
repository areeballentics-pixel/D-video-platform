"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type SeatUpgradeRequest } from "@/lib/api";

type Tab = "pending" | "fulfilled" | "rejected";

export default function UpgradeRequestsPage() {
  const [tab, setTab] = useState<Tab>("pending");
  const [requests, setRequests] = useState<SeatUpgradeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [actionTarget, setActionTarget] = useState<{
    request: SeatUpgradeRequest;
    mode: "fulfill" | "reject";
  } | null>(null);
  const [newCap, setNewCap] = useState<number>(1);
  const [notes, setNotes] = useState("");
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listUpgradeRequests(tab);
      setRequests(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  const openFulfill = (r: SeatUpgradeRequest) => {
    setActionTarget({ request: r, mode: "fulfill" });
    setNewCap(Math.max(r.requested_seats, r.current_seats));
    setNotes("");
  };

  const openReject = (r: SeatUpgradeRequest) => {
    setActionTarget({ request: r, mode: "reject" });
    setNotes("");
  };

  const handleAction = async () => {
    if (!actionTarget) return;
    setActing(true);
    setError("");
    try {
      if (actionTarget.mode === "fulfill") {
        await api.fulfillUpgradeRequest(actionTarget.request.id, {
          new_max_encryptor_devices: newCap,
          handled_notes: notes,
        });
      } else {
        await api.rejectUpgradeRequest(actionTarget.request.id, notes);
      }
      setActionTarget(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActing(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">
          Encryptor seat upgrade requests
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Tenants ask for more encryptor seats here. Approve a request to bump
          their cap immediately, or reject with a note explaining why.
        </p>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-1 rounded-lg border border-border bg-bg-surface p-1">
        {(["pending", "fulfilled", "rejected"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              tab === t
                ? "bg-primary text-white"
                : "text-text-muted hover:bg-bg-surface-hover"
            }`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : requests.length === 0 ? (
        <div className="rounded-xl border border-border bg-bg-surface py-16 text-center text-sm text-text-muted">
          No {tab} requests.
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => (
            <div
              key={r.id}
              className="rounded-xl border border-border bg-bg-surface p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3">
                    <h3 className="font-semibold text-text-primary">
                      {r.tenant_name}
                    </h3>
                    <code className="rounded bg-bg-primary px-2 py-0.5 text-xs text-text-muted font-mono">
                      {r.tenant_slug}
                    </code>
                  </div>
                  <p className="mt-2 text-sm text-text-muted">
                    Requested by{" "}
                    <span className="text-text-primary">
                      {r.requested_by_email ?? "unknown"}
                    </span>{" "}
                    on{" "}
                    {new Date(r.requested_at).toLocaleString("en-US", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </p>
                  <p className="mt-1 text-sm">
                    Asking for{" "}
                    <span className="font-bold text-primary">
                      {r.requested_seats}
                    </span>{" "}
                    seats (currently {r.current_seats})
                  </p>
                  {r.notes && (
                    <p className="mt-3 rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-muted">
                      {r.notes}
                    </p>
                  )}
                  {r.handled_at && (
                    <p className="mt-2 text-xs text-text-muted/70">
                      Handled{" "}
                      {new Date(r.handled_at).toLocaleString("en-US", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                      {r.handled_notes ? ` · "${r.handled_notes}"` : ""}
                    </p>
                  )}
                </div>

                {r.status === "pending" && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => openReject(r)}
                      className="rounded-lg border border-error/30 px-3 py-1.5 text-xs font-medium text-error hover:bg-error/10"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => openFulfill(r)}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover"
                    >
                      Fulfill
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Action modal */}
      {actionTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-bg-surface p-6">
            <h2 className="mb-1 text-lg font-bold text-text-primary">
              {actionTarget.mode === "fulfill" ? "Fulfill request" : "Reject request"}
            </h2>
            <p className="mb-4 text-xs text-text-muted">
              {actionTarget.request.tenant_name} · asking for{" "}
              {actionTarget.request.requested_seats} seats
            </p>

            {actionTarget.mode === "fulfill" && (
              <>
                <label className="mb-1.5 block text-sm font-medium text-text-muted">
                  New seat cap
                </label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={newCap}
                  onChange={(e) =>
                    setNewCap(parseInt(e.target.value, 10) || 1)
                  }
                  className="mb-4 w-full rounded-lg border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                />
              </>
            )}

            <label className="mb-1.5 block text-sm font-medium text-text-muted">
              Notes (visible to tenant in audit log)
            </label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                actionTarget.mode === "fulfill"
                  ? "Approved as part of Pro plan upgrade."
                  : "Reason for rejection — billing dispute, etc."
              }
              className="mb-4 w-full rounded-lg border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />

            <div className="flex gap-3">
              <button
                onClick={() => setActionTarget(null)}
                disabled={acting}
                className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-text-muted hover:bg-bg-surface-hover disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleAction}
                disabled={acting}
                className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 ${
                  actionTarget.mode === "fulfill"
                    ? "bg-primary hover:bg-primary-hover"
                    : "bg-error hover:bg-error/90"
                }`}
              >
                {acting
                  ? "Submitting…"
                  : actionTarget.mode === "fulfill"
                  ? "Fulfill"
                  : "Reject"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
