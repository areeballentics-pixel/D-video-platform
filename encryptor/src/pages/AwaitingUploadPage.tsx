// "Distribution" page — formerly "Awaiting upload" when there was a strict
// pending_urls flow. Now all videos go live immediately on encryption; this
// page is where the institute manages distribution metadata: optional Drive
// URLs (for online auto-download), free-preview flag, stream-only flag.

import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPut } from "@/lib/rest";

interface VideoRow {
  video_id: string;
  title: string;
  qualities: string[];
  duration_ms: number;
  created_at: string;
}

interface VideoDetail {
  video_id: string;
  title: string;
  qualities: string[];
  duration_ms: number;
  download_urls?: Record<string, string>;
  is_free_preview?: boolean;
  is_stream_only?: boolean;
  status?: string;
}

export default function AwaitingUploadPage() {
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<VideoRow | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<{ videos: VideoRow[] }>("/api/admin/videos");
      setVideos(data.videos);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  // Permanently deletes the video (row + cascade) — distinct from the
  // course-detach "Remove" in CoursesPage. Confirms first, then re-fetches.
  const handleDelete = useCallback(
    async (v: VideoRow) => {
      const ok = window.confirm(
        `Delete "${v.title}" permanently?\n\n` +
          "This removes it from all courses and cannot be undone.",
      );
      if (!ok) return;
      setError("");
      setDeletingId(v.video_id);
      try {
        await apiDelete(`/api/admin/videos/${v.video_id}`);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Delete failed");
      } finally {
        setDeletingId(null);
      }
    },
    [load],
  );

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Distribution</h1>
        <p className="mt-1 text-sm text-slate-400">
          Manage how each video reaches students. Drive URLs are optional —
          you can also distribute by USB / pendrive / email; the player
          plays whatever <code className="text-slate-300">.svf</code> the
          student has locally.
        </p>
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
      ) : videos.length === 0 ? (
        <p className="rounded-2xl border border-slate-800 bg-slate-900 py-10 text-center text-sm text-slate-500">
          No videos yet. Encrypt one from the Jobs tab.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-2.5 text-left">Title</th>
                <th className="px-4 py-2.5 text-left">Qualities</th>
                <th className="px-4 py-2.5 text-left">Created</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-950">
              {videos.map((v) => (
                <tr key={v.video_id} className="hover:bg-slate-900">
                  <td className="px-4 py-2.5">{v.title}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-400">
                    {v.qualities.join(", ") || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">
                    {new Date(v.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setEditing(v)}
                        className="rounded-md border border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-800"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(v)}
                        disabled={deletingId === v.video_id}
                        title="Delete this video permanently"
                        className="rounded-md border border-red-900 px-2.5 py-1 text-xs text-red-300 hover:bg-red-950 disabled:opacity-50"
                      >
                        {deletingId === v.video_id ? "Deleting…" : "Delete video"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EditDrawer
          video={editing}
          onClose={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function EditDrawer({
  video,
  onClose,
}: {
  video: VideoRow;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // URL form state — one input per quality.
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [isFreePreview, setIsFreePreview] = useState(false);
  const [isStreamOnly, setIsStreamOnly] = useState(false);

  useEffect(() => {
    apiGet<{ videos: VideoDetail[] }>("/api/admin/videos")
      .then((r) => {
        const v = r.videos.find((x) => x.video_id === video.video_id);
        if (v) {
          setDetail(v);
          // Server returns flags in the list endpoint? If not, default false.
          setIsFreePreview(Boolean(v.is_free_preview));
          setIsStreamOnly(Boolean(v.is_stream_only));
          setUrls(
            Object.fromEntries(
              video.qualities.map((q) => [q, (v.download_urls ?? {})[q] ?? ""]),
            ),
          );
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, [video.video_id, video.qualities]);

  const saveUrls = async () => {
    const cleaned = Object.fromEntries(
      Object.entries(urls).filter(([, v]) => v.trim().length > 0),
    );
    setSaving(true);
    setError("");
    try {
      await apiPut(`/api/admin/videos/${video.video_id}/download-urls`, {
        download_urls: cleaned,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const saveFlags = async () => {
    setSaving(true);
    setError("");
    try {
      await apiPatch(`/api/admin/videos/${video.video_id}`, {
        is_free_preview: isFreePreview,
        is_stream_only: isStreamOnly,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-y-auto bg-slate-950 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">{video.title}</h2>
            <p className="text-xs text-slate-500 font-mono">
              {video.video_id}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md border border-slate-700 px-3 py-1 text-sm hover:bg-slate-800"
          >
            Close
          </button>
        </div>

        {error && (
          <p className="mb-3 rounded-md border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        {!detail ? (
          <div className="flex items-center justify-center py-10">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : (
          <>
            {/* URLs */}
            <section className="mb-5 rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h3 className="mb-2 text-sm font-semibold">Download URLs</h3>
              <p className="mb-3 text-xs text-slate-500">
                Optional. Set a Drive (or any HTTPS) link per quality so the
                player auto-downloads. Leave blank if you're distributing by
                USB / pendrive / direct file copy.
              </p>
              <div className="space-y-2">
                {video.qualities.map((q) => (
                  <div key={q} className="flex items-center gap-2">
                    <span className="w-16 text-xs uppercase text-slate-400">
                      {q}
                    </span>
                    <input
                      type="url"
                      placeholder="https://drive.google.com/…"
                      value={urls[q] ?? ""}
                      onChange={(e) =>
                        setUrls((p) => ({ ...p, [q]: e.target.value }))
                      }
                      className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                    />
                  </div>
                ))}
              </div>
              <button
                onClick={saveUrls}
                disabled={saving}
                className="mt-3 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save URLs"}
              </button>
            </section>

            {/* Flags */}
            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h3 className="mb-3 text-sm font-semibold">Distribution flags</h3>

              <label className="mb-3 flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isFreePreview}
                  onChange={(e) => setIsFreePreview(e.target.checked)}
                  className="mt-0.5"
                />
                <div className="flex-1">
                  <p className="text-sm">Free preview</p>
                  <p className="text-xs text-slate-500">
                    Any logged-in student can play this video, even without
                    being enrolled in a course. Useful as a marketing hook.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isStreamOnly}
                  onChange={(e) => setIsStreamOnly(e.target.checked)}
                  className="mt-0.5"
                />
                <div className="flex-1">
                  <p className="text-sm">Stream only</p>
                  <p className="text-xs text-slate-500">
                    Disallow offline download on student devices. Player will
                    refuse to cache the .svf locally.
                  </p>
                </div>
              </label>

              <button
                onClick={saveFlags}
                disabled={saving}
                className="mt-3 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save flags"}
              </button>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
