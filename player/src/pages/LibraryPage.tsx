import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { scanLibrary, getStudentBatches } from "../lib/tauri";
import type { SvfInfo, StudentBatch } from "../lib/types";

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatSize(quality: string): string {
  const map: Record<string, string> = {
    "480p": "SD",
    "720p": "HD",
    "1080p": "FHD",
  };
  return map[quality] || quality;
}

function normalizeId(id: string): string {
  return (id || "").replace(/[^a-fA-F0-9]/g, "").toLowerCase();
}

export default function LibraryPage() {
  const navigate = useNavigate();

  // State
  const [batches, setBatches] = useState<StudentBatch[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string>("");
  const [scannedVideos, setScannedVideos] = useState<SvfInfo[]>([]);
  const [folderPath, setFolderPath] = useState<string>(() => {
    return localStorage.getItem("svp_library_path") || "";
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isOffline, setIsOffline] = useState(false);

  // Load batches (with offline cache fallback)
  useEffect(() => {
    loadBatches();
  }, []);

  // Scan folder when it changes
  useEffect(() => {
    if (folderPath) {
      loadLibrary(folderPath);
    }
  }, [folderPath]);

  async function loadBatches() {
    try {
      const resp = await getStudentBatches();
      if (resp && resp.batches && resp.batches.length > 0) {
        setBatches(resp.batches);
        localStorage.setItem("svp_cached_batches", JSON.stringify(resp.batches));
        setActiveBatchId((prev) => prev || resp.batches[0].id);
        setIsOffline(false);
      } else {
        // Fallback to cache if server returned empty or offline
        loadFromCache();
      }
    } catch (err) {
      // Network/offline error -> load from cache
      setIsOffline(true);
      loadFromCache();
    }
  }

  function loadFromCache() {
    const cached = localStorage.getItem("svp_cached_batches");
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as StudentBatch[];
        if (parsed.length > 0) {
          setBatches(parsed);
          setActiveBatchId((prev) => prev || parsed[0].id);
        }
      } catch {
        // ignore parse error
      }
    }
  }

  async function loadLibrary(folder: string) {
    setLoading(true);
    setError("");
    try {
      const results = await scanLibrary(folder);
      setScannedVideos(results);
      localStorage.setItem("svp_library_path", folder);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setScannedVideos([]);
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

  function handlePlay(filePathOrId: string) {
    navigate(`/player?path=${encodeURIComponent(filePathOrId)}`);
  }

  // Fast lookup of scanned local files by normalized 32-hex ID
  const localFilesById = useMemo(() => {
    const map = new Map<string, SvfInfo>();
    for (const v of scannedVideos) {
      const norm = normalizeId(v.video_id);
      if (norm) {
        map.set(norm, v);
      }
    }
    return map;
  }, [scannedVideos]);

  // Current active batch
  const currentBatch = useMemo(() => {
    return batches.find((b) => b.id === activeBatchId);
  }, [batches, activeBatchId]);

  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg)]">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold">My Batches & Playlists</h1>
            {isOffline && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-500 border border-amber-500/20">
                Offline Mode (Cached)
              </span>
            )}
          </div>
          {folderPath ? (
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)] truncate max-w-md">
              Folder: {folderPath}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-amber-500">
              Please select the folder containing your .svf videos
            </p>
          )}
        </div>
        <div className="flex gap-3">
          <button
            onClick={loadBatches}
            title="Refresh playlists from server"
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            ↻ Refresh
          </button>
          <button
            onClick={handleSelectFolder}
            className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] transition-colors"
          >
            {folderPath ? "Change Folder" : "Select Video Folder"}
          </button>
          <button
            onClick={() => navigate("/settings")}
            className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            Settings
          </button>
        </div>
      </header>

      {/* Batch Navigation Tabs */}
      {batches.length > 0 && (
        <div className="flex border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 overflow-x-auto gap-2 py-2">
          {batches.map((batch) => {
            const isActive = batch.id === activeBatchId;
            // Count how many videos in this batch are found locally
            const readyCount = batch.videos.filter((v) => {
              const norm = normalizeId(v.video_id_hex || v.video_id);
              return localFilesById.has(norm);
            }).length;

            return (
              <button
                key={batch.id}
                onClick={() => setActiveBatchId(batch.id)}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all whitespace-nowrap ${
                  isActive
                    ? "bg-[var(--color-primary)] text-white shadow-sm"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                }`}
              >
                <span>{batch.name}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    isActive
                      ? "bg-white/20 text-white"
                      : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"
                  }`}
                >
                  {readyCount}/{batch.videos.length} Ready
                </span>
              </button>
            );
          })}

          {/* Fallback All Files Tab */}
          <button
            onClick={() => setActiveBatchId("__all__")}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all whitespace-nowrap ${
              activeBatchId === "__all__"
                ? "bg-[var(--color-primary)] text-white shadow-sm"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
            }`}
          >
            <span>All Local Files</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                activeBatchId === "__all__"
                  ? "bg-white/20 text-white"
                  : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"
              }`}
            >
              {scannedVideos.length}
            </span>
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 p-4 text-sm text-[var(--color-error)]">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-[var(--color-text-muted)]">Scanning video folders...</p>
          </div>
        ) : batches.length === 0 && scannedVideos.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[var(--color-text-muted)]">
            <div className="text-center max-w-md">
              <p className="mb-3 text-5xl opacity-40">📁</p>
              <h2 className="text-lg font-semibold text-[var(--color-text)]">
                {folderPath ? "No .svf videos found" : "Select Your Video Folder"}
              </h2>
              <p className="mt-2 text-sm">
                {folderPath
                  ? "We couldn't find any encrypted .svf files in this folder. Make sure your downloaded Google Drive videos are here."
                  : "Click 'Select Video Folder' above to point to where your Google Drive videos are stored on your PC."}
              </p>
              {!folderPath && (
                <button
                  onClick={handleSelectFolder}
                  className="mt-4 rounded-lg bg-[var(--color-primary)] px-5 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] transition-colors"
                >
                  Select Folder
                </button>
              )}
            </div>
          </div>
        ) : activeBatchId === "__all__" || (!currentBatch && batches.length === 0) ? (
          /* "All Local Files" View */
          <div>
            <div className="mb-4">
              <h2 className="text-base font-semibold">All Detected Local Videos</h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                Direct list of all {scannedVideos.length} .svf files found in your local folder.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {scannedVideos.map((video) => (
                <button
                  key={video.file_path || video.video_id}
                  onClick={() => handlePlay(video.file_path || video.video_id)}
                  className="group rounded-xl bg-[var(--color-surface)] p-4 text-left transition-all hover:bg-[var(--color-surface-hover)] hover:shadow-lg hover:shadow-[var(--color-primary)]/5 border border-[var(--color-border)]"
                >
                  <div className="mb-3 flex aspect-video items-center justify-center rounded-lg bg-[var(--color-bg)]">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-primary)]/20 text-[var(--color-primary)] transition-transform group-hover:scale-110">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>
                  </div>
                  <h3 className="mb-1 text-sm font-semibold truncate text-[var(--color-text)]">
                    {video.title}
                  </h3>
                  <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                    <span>{formatDuration(video.duration_ms)}</span>
                    <span className="opacity-30">|</span>
                    <span className="rounded bg-[var(--color-primary)]/20 px-1.5 py-0.5 text-[var(--color-primary)] font-medium">
                      {formatSize(video.quality)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : currentBatch ? (
          /* Active Batch Playlist View */
          <div className="max-w-5xl mx-auto space-y-6">
            {/* Batch Info Card */}
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-bold text-[var(--color-text)]">
                    {currentBatch.name}
                  </h2>
                  {currentBatch.description && (
                    <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                      {currentBatch.description}
                    </p>
                  )}
                  {currentBatch.tags && currentBatch.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {currentBatch.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-md bg-[var(--color-bg)] px-2 py-0.5 text-xs text-[var(--color-text-muted)] border border-[var(--color-border)]"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="text-right">
                  <span className="text-sm font-medium text-[var(--color-text)]">
                    {currentBatch.videos.length} Lectures Total
                  </span>
                </div>
              </div>
            </div>

            {/* Videos List / Playlist */}
            <div className="space-y-3">
              {currentBatch.videos.length === 0 ? (
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
                  No lectures have been added to this batch yet.
                </div>
              ) : (
                currentBatch.videos.map((bv, idx) => {
                  const norm = normalizeId(bv.video_id_hex || bv.video_id);
                  const localMatch = localFilesById.get(norm);
                  const isAvailable = Boolean(localMatch);

                  return (
                    <div
                      key={bv.video_id}
                      className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border p-4 transition-all ${
                        isAvailable
                          ? "border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] shadow-sm"
                          : "border-dashed border-[var(--color-border)] bg-[var(--color-surface)]/50 opacity-75"
                      }`}
                    >
                      <div className="flex items-center gap-4">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-bg)] text-xs font-mono font-semibold text-[var(--color-text-muted)]">
                          {(bv.display_order ?? idx + 1).toString().padStart(2, "0")}
                        </span>
                        <div>
                          <h4 className="text-sm font-semibold text-[var(--color-text)]">
                            {bv.title}
                          </h4>
                          <div className="flex items-center gap-2 mt-1 text-xs text-[var(--color-text-muted)]">
                            {bv.duration_ms > 0 && (
                              <>
                                <span>{formatDuration(bv.duration_ms)}</span>
                                <span className="opacity-30">•</span>
                              </>
                            )}
                            {bv.is_free_preview && (
                              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-400 font-medium border border-emerald-500/20">
                                Free Preview
                              </span>
                            )}
                            {isAvailable ? (
                              <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-emerald-400 font-medium flex items-center gap-1">
                                ✓ Available on PC
                              </span>
                            ) : (
                              <span className="rounded bg-amber-500/10 px-2 py-0.5 text-amber-400 font-medium">
                                Missing from folder
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        {isAvailable ? (
                          <button
                            onClick={() =>
                              handlePlay(localMatch!.file_path || localMatch!.video_id)
                            }
                            className="flex items-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--color-primary-hover)] transition-colors shadow-sm"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                            Play Lecture
                          </button>
                        ) : (
                          <span
                            title="Download this .svf file from your Google Drive into your video folder"
                            className="text-xs text-[var(--color-text-muted)] italic"
                          >
                            Not in local folder
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
