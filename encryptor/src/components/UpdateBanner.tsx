import { useEffect, useState } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export default function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    async function checkForUpdates() {
      try {
        const u = await check();
        if (u) {
          setUpdate(u);
        }
      } catch (err) {
        // Silently ignore if offline or no endpoint reached
        console.debug("Update check:", err);
      }
    }
    checkForUpdates();
  }, []);

  if (!update || dismissed) return null;

  async function handleUpdate() {
    if (!update) return;
    try {
      setDownloading(true);
      let downloaded = 0;
      let total = 0;

      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength || 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) {
            setProgress(Math.round((downloaded / total) * 100));
          }
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });

      await relaunch();
    } catch (err) {
      console.error("Failed to update:", err);
      setDownloading(false);
      alert("Update failed: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  return (
    <div className="fixed top-3 right-3 z-50 flex items-center gap-3 rounded-lg border border-blue-500/40 bg-slate-900/95 p-3.5 shadow-2xl backdrop-blur-md">
      <div className="flex items-center gap-2.5">
        <span className="flex h-2.5 w-2.5 rounded-full bg-blue-500 animate-pulse" />
        <div>
          <p className="text-xs font-semibold text-white">
            Update Available: v{update.version}
          </p>
          <p className="text-[11px] text-slate-400">
            {downloading
              ? progress !== null
                ? `Downloading... ${progress}%`
                : "Downloading update..."
              : "A new version of the app is ready to install."}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 ml-2">
        <button
          onClick={handleUpdate}
          disabled={downloading}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
        >
          {downloading ? "Installing..." : "Update Now"}
        </button>
        {!downloading && (
          <button
            onClick={() => setDismissed(true)}
            className="rounded p-1 text-slate-400 hover:text-white"
            title="Dismiss"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
