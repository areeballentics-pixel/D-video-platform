import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { scanLibrary } from "../lib/tauri";
import type { SvfInfo } from "../lib/types";

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatSize(quality: string): string {
  // Rough size indicators based on quality
  const map: Record<string, string> = {
    "480p": "SD",
    "720p": "HD",
    "1080p": "FHD",
  };
  return map[quality] || quality;
}

export default function LibraryPage() {
  const navigate = useNavigate();
  const [videos, setVideos] = useState<SvfInfo[]>([]);
  const [folderPath, setFolderPath] = useState<string>(() => {
    return localStorage.getItem("svp_library_path") || "";
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Scan folder when it changes
  useEffect(() => {
    if (folderPath) {
      loadLibrary(folderPath);
    }
  }, [folderPath]);

  async function loadLibrary(folder: string) {
    setLoading(true);
    setError("");
    try {
      const results = await scanLibrary(folder);
      setVideos(results);
      localStorage.setItem("svp_library_path", folder);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setVideos([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectFolder() {
    const selected = await open({
      directory: true,
      title: "Select Video Folder",
    });
    if (selected) {
      setFolderPath(selected as string);
    }
  }

  function handlePlayVideo(video: SvfInfo) {
    // Navigate to player page with the file path
    navigate(`/player?path=${encodeURIComponent(video.video_id)}`);
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-4">
        <div>
          <h1 className="text-lg font-bold">My Videos</h1>
          {folderPath && (
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)] truncate max-w-md">
              {folderPath}
            </p>
          )}
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleSelectFolder}
            className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] transition-colors"
          >
            {folderPath ? "Change Folder" : "Select Folder"}
          </button>
          <button
            onClick={() => navigate("/settings")}
            className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            Settings
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 p-4 text-sm text-[var(--color-error)]">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-[var(--color-text-muted)]">Scanning folder...</p>
          </div>
        ) : videos.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[var(--color-text-muted)]">
            <div className="text-center">
              <p className="mb-2 text-5xl opacity-50">
                {folderPath ? "0" : "?"}
              </p>
              <p className="text-lg font-medium">
                {folderPath ? "No .svf videos found" : "No folder selected"}
              </p>
              <p className="mt-1 text-sm">
                {folderPath
                  ? "Make sure the folder contains encrypted .svf files"
                  : "Click 'Select Folder' to choose a folder with .svf videos"}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {videos.map((video) => (
              <button
                key={video.video_id}
                onClick={() => handlePlayVideo(video)}
                className="group rounded-xl bg-[var(--color-surface)] p-4 text-left transition-all hover:bg-[var(--color-surface-hover)] hover:shadow-lg hover:shadow-[var(--color-primary)]/5"
              >
                {/* Thumbnail placeholder */}
                <div className="mb-3 flex aspect-video items-center justify-center rounded-lg bg-[var(--color-bg)]">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-primary)]/20 text-[var(--color-primary)] transition-transform group-hover:scale-110">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                </div>

                {/* Info */}
                <h3 className="mb-1 text-sm font-semibold truncate">
                  {video.title}
                </h3>
                <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                  <span>{formatDuration(video.duration_ms)}</span>
                  <span className="opacity-30">|</span>
                  <span>
                    {video.width}x{video.height}
                  </span>
                  <span className="opacity-30">|</span>
                  <span className="rounded bg-[var(--color-primary)]/20 px-1.5 py-0.5 text-[var(--color-primary)] font-medium">
                    {formatSize(video.quality)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
