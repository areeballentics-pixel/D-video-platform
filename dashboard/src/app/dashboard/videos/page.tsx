"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { api, type Video } from "@/lib/api";

function formatDuration(ms: number): string {
  if (!ms) return "--:--";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function VideosPage() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [downloadOpen, setDownloadOpen] = useState<string | null>(null);

  const loadVideos = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.listVideos();
      setVideos(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load videos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadVideos();
  }, [loadVideos]);

  const handleDelete = async (videoId: string) => {
    try {
      setDeleting(videoId);
      await api.deleteVideo(videoId);
      setVideos((prev) => prev.filter((v) => v.video_id !== videoId));
      setDeleteConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(null);
    }
  };

  const handleDownload = async (videoId: string, quality: string) => {
    try {
      await api.downloadVideo(videoId, quality);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    }
    setDownloadOpen(null);
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Video Library</h1>
          <p className="mt-1 text-sm text-text-muted">
            Manage your encrypted video content
          </p>
        </div>
        <Link
          href="/dashboard/upload"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Upload Video
        </Link>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          {error}
          <button onClick={() => setError("")} className="ml-2 font-semibold hover:underline">
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
      {!loading && videos.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-bg-surface py-20">
          <svg className="mb-4 h-16 w-16 text-text-muted/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <p className="text-lg font-medium text-text-muted">No videos yet</p>
          <p className="mt-1 text-sm text-text-muted/70">
            Upload your first video to get started
          </p>
          <Link
            href="/dashboard/upload"
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
          >
            Upload Video
          </Link>
        </div>
      )}

      {/* Video grid */}
      {!loading && videos.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {videos.map((video) => (
            <div
              key={video.video_id}
              className="group rounded-xl border border-border bg-bg-surface p-5 transition-colors hover:border-primary/30"
            >
              {/* Video icon placeholder */}
              <div className="mb-4 flex h-32 items-center justify-center rounded-lg bg-bg-primary">
                <svg className="h-12 w-12 text-text-muted/20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                </svg>
              </div>

              {/* Title */}
              <h3 className="mb-2 truncate text-sm font-semibold text-text-primary">
                {video.title}
              </h3>

              {/* Quality badges */}
              <div className="mb-3 flex flex-wrap gap-1.5">
                {video.qualities.map((q) => (
                  <span
                    key={q}
                    className="inline-flex rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                  >
                    {q}
                  </span>
                ))}
              </div>

              {/* Meta */}
              <div className="mb-4 flex items-center gap-4 text-xs text-text-muted">
                <span className="flex items-center gap-1">
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {formatDuration(video.duration_ms)}
                </span>
                <span>{formatDate(video.created_at)}</span>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2">
                {/* Download dropdown */}
                <div className="relative">
                  <button
                    onClick={() =>
                      setDownloadOpen(
                        downloadOpen === video.video_id ? null : video.video_id
                      )
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:border-primary/30 hover:text-primary"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                    </svg>
                    Download
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    </svg>
                  </button>
                  {downloadOpen === video.video_id && (
                    <div className="absolute left-0 top-full z-10 mt-1 w-32 rounded-lg border border-border bg-bg-surface py-1 shadow-lg">
                      {video.qualities.map((q) => (
                        <button
                          key={q}
                          onClick={() => handleDownload(video.video_id, q)}
                          className="block w-full px-3 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-surface-hover hover:text-text-primary"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Delete */}
                {deleteConfirm === video.video_id ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleDelete(video.video_id)}
                      disabled={deleting === video.video_id}
                      className="rounded-lg bg-error px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-error/80 disabled:opacity-50"
                    >
                      {deleting === video.video_id ? "..." : "Confirm"}
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(null)}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:border-text-muted"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeleteConfirm(video.video_id)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:border-error/30 hover:text-error"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
