import { useState } from "react";
import { tauri } from "@/lib/tauri";
import { useAppStore } from "@/store/appStore";
import { JobInfo, JobStatus } from "@/lib/types";

// --- Folder Batch State -------------------------------------------------------

interface FolderBatchState {
  folderPath: string;
  batchName: string;
  submitting: boolean;
  error: string | null;
}

// --- Main Page ----------------------------------------------------------------

export default function JobsPage() {
  const { jobs, refresh } = useAppStore();

  // Single-file state
  const [pickedFile, setPickedFile] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Folder-batch state
  const [batch, setBatch] = useState<FolderBatchState>({
    folderPath: "",
    batchName: "",
    submitting: false,
    error: null,
  });

  // Which panel is open: "single" | "folder"
  const [mode, setMode] = useState<"single" | "folder">("single");

  // -- Single-file handlers --------------------------------------------------
  const handlePickFile = async () => {
    const path = await tauri.pickVideoFile();
    if (path) {
      setPickedFile(path);
      if (!title) {
        const base = path.split(/[/\\]/).pop() ?? "";
        setTitle(base.replace(/\.[^.]+$/, ""));
      }
    }
  };

  const handleStart = async () => {
    if (!pickedFile || !title) return;
    setSubmitting(true);
    setError(null);
    try {
      await tauri.startEncryptionJob(pickedFile, title);
      await refresh();
      setPickedFile(null);
      setTitle("");
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to start job");
    } finally {
      setSubmitting(false);
    }
  };

  // -- Folder-batch handlers -------------------------------------------------
  const handlePickFolder = async () => {
    const path = await tauri.pickFolder();
    if (path) {
      const folderName = path.split(/[/\\]/).pop() ?? "";
      setBatch((prev) => ({
        ...prev,
        folderPath: path,
        batchName: prev.batchName || folderName,
      }));
    }
  };

  const handleStartBatch = async () => {
    if (!batch.folderPath) return;
    setBatch((prev) => ({ ...prev, submitting: true, error: null }));
    try {
      const result = await tauri.startFolderBatch(
        batch.folderPath,
        batch.batchName || undefined,
      );
      await refresh();
      setBatch({ folderPath: "", batchName: "", submitting: false, error: null });
      if (result.skipped > 0) {
        // Non-fatal notice
        setBatch((prev) => ({
          ...prev,
          error: `${result.queued} video(s) queued. ${result.skipped} file(s) skipped (not a valid video).`,
        }));
      }
    } catch (err) {
      setBatch((prev) => ({
        ...prev,
        submitting: false,
        error: typeof err === "string" ? err : "Failed to start batch",
      }));
    }
  };

  // -- Job grouping ----------------------------------------------------------
  const activeJobs = jobs.filter((j) =>
    ["queued", "running"].includes(j.status),
  );
  const otherJobs = jobs.filter(
    (j) => !["queued", "running"].includes(j.status),
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold">Encryption jobs</h1>

      {/* -- Mode toggle ----------------------------------------------------- */}
      <div className="flex gap-2 border-b border-slate-800 pb-1">
        <button
          onClick={() => setMode("single")}
          className={`rounded-t px-4 py-1.5 text-sm font-medium transition-colors ${
            mode === "single"
              ? "border border-b-0 border-slate-700 bg-slate-900 text-white"
              : "text-slate-400 hover:text-white"
          }`}
        >
          Single video
        </button>
        <button
          onClick={() => setMode("folder")}
          className={`rounded-t px-4 py-1.5 text-sm font-medium transition-colors ${
            mode === "folder"
              ? "border border-b-0 border-slate-700 bg-slate-900 text-white"
              : "text-slate-400 hover:text-white"
          }`}
        >
          ?? Encrypt folder (batch)
        </button>
      </div>

      {/* -- Single-video panel ---------------------------------------------- */}
      {mode === "single" && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <h2 className="mb-3 text-sm font-semibold text-slate-200">
            Start a new encryption
          </h2>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <button
                onClick={handlePickFile}
                className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700"
              >
                {pickedFile ? "Change file…" : "Pick video file…"}
              </button>
              <p className="truncate text-sm text-slate-400">
                {pickedFile ?? "No file selected"}
              </p>
            </div>

            <input
              type="text"
              placeholder="Video title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />

            <p className="text-xs text-slate-500">
              Quality label auto-detected from MP4 dimensions. The file is
              encrypted as-is — its resolution doesn&rsquo;t change.
            </p>

            {error && (
              <p className="rounded-md border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
                {error}
              </p>
            )}

            <button
              onClick={handleStart}
              disabled={!pickedFile || !title || submitting}
              className="rounded-md bg-primary px-4 py-2 font-medium text-white hover:bg-primary-dark disabled:opacity-50"
            >
              {submitting ? "Starting…" : "Start encryption"}
            </button>
          </div>
        </div>
      )}

      {/* -- Folder-batch panel ---------------------------------------------- */}
      {mode === "folder" && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <h2 className="mb-1 text-sm font-semibold text-slate-200">
            Encrypt an entire folder
          </h2>
          <p className="mb-4 text-xs text-slate-500">
            Pick a folder — every video inside will be encrypted automatically.
            The folder name is used as the batch name.
          </p>

          <div className="space-y-3">
            {/* Folder picker */}
            <div className="flex items-center gap-3">
              <button
                onClick={handlePickFolder}
                className="shrink-0 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700"
              >
                {batch.folderPath ? "Change folder…" : "Pick folder…"}
              </button>
              <p className="truncate text-sm text-slate-400">
                {batch.folderPath || "No folder selected"}
              </p>
            </div>

            {/* Batch name (editable, auto-filled from folder name) */}
            <div>
              <label className="mb-1 block text-xs text-slate-400">
                Batch name
              </label>
              <input
                type="text"
                placeholder="Auto-filled from folder name"
                value={batch.batchName}
                onChange={(e) =>
                  setBatch((prev) => ({ ...prev, batchName: e.target.value }))
                }
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-slate-500">
                You can edit this — it&apos;s how the batch will appear in the
                list below.
              </p>
            </div>

            {batch.error && (
              <p
                className={`rounded-md border px-3 py-2 text-sm ${
                  batch.error.includes("queued")
                    ? "border-amber-800 bg-amber-950 text-amber-300"
                    : "border-red-900 bg-red-950 text-red-300"
                }`}
              >
                {batch.error}
              </p>
            )}

            <button
              onClick={handleStartBatch}
              disabled={!batch.folderPath || batch.submitting}
              className="rounded-md bg-primary px-4 py-2 font-medium text-white hover:bg-primary-dark disabled:opacity-50"
            >
              {batch.submitting ? "Queuing videos…" : "Start batch encryption"}
            </button>
          </div>
        </div>
      )}

      {/* -- Active jobs ----------------------------------------------------- */}
      {activeJobs.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-300">
            Active ({activeJobs.length})
          </h2>
          <JobGroupedList jobs={activeJobs} />
        </section>
      )}

      {/* -- History --------------------------------------------------------- */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-300">
          History ({otherJobs.length})
        </h2>
        {otherJobs.length === 0 ? (
          <p className="text-sm text-slate-500">No completed jobs yet.</p>
        ) : (
          <JobGroupedList jobs={otherJobs} />
        )}
      </section>
    </div>
  );
}

// --- Grouped job list (batches collapsed under a header) ---------------------

function JobGroupedList({ jobs }: { jobs: JobInfo[] }) {
  // Separate batch jobs from single-file jobs.
  const batches = new Map<string, JobInfo[]>();
  const singles: JobInfo[] = [];

  for (const job of jobs) {
    if (job.batch_id) {
      const existing = batches.get(job.batch_id) ?? [];
      existing.push(job);
      batches.set(job.batch_id, existing);
    } else {
      singles.push(job);
    }
  }

  return (
    <div className="space-y-3">
      {/* Render batch groups first */}
      {Array.from(batches.entries()).map(([batchId, batchJobs]) => (
        <BatchGroup key={batchId} jobs={batchJobs} />
      ))}
      {/* Then individual jobs */}
      {singles.map((j) => (
        <JobCard key={j.id} job={j} />
      ))}
    </div>
  );
}

// --- Batch group card ---------------------------------------------------------

function BatchGroup({ jobs }: { jobs: JobInfo[] }) {
  const [expanded, setExpanded] = useState(true);
  const batchName = jobs[0]?.batch_name ?? "Batch";

  const done = jobs.filter((j) =>
    ["live", "failed", "cancelled"].includes(j.status),
  ).length;
  const failed = jobs.filter((j) => j.status === "failed").length;
  const total = jobs.length;

  const allDone = done === total;
  const anyFailed = failed > 0;

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60">
      {/* Batch header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-base">??</span>
          <div className="min-w-0">
            <p className="truncate font-medium text-slate-100">{batchName}</p>
            <p className="text-xs text-slate-400">
              {done}/{total} done
              {anyFailed ? ` · ${failed} failed` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {/* Overall progress bar */}
          <div className="w-24 h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                anyFailed ? "bg-red-500" : allDone ? "bg-emerald-500" : "bg-primary"
              }`}
              style={{ width: `${Math.round((done / total) * 100)}%` }}
            />
          </div>
          <span className="text-xs text-slate-500">
            {expanded ? "?" : "?"}
          </span>
        </div>
      </button>

      {/* Individual job cards inside the batch */}
      {expanded && (
        <div className="border-t border-slate-800 px-3 pb-3 pt-2 space-y-2">
          {jobs.map((j) => (
            <JobCard key={j.id} job={j} compact />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Single job card ----------------------------------------------------------

function JobCard({ job, compact = false }: { job: JobInfo; compact?: boolean }) {
  const pct =
    job.bytes_total > 0
      ? Math.min(100, Math.round((job.bytes_processed / job.bytes_total) * 100))
      : 0;
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

  return (
    <div
      className={`rounded-md border border-slate-800 bg-slate-900 ${
        compact ? "p-3" : "p-4"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{job.title}</p>
          {!compact && (
            <p className="truncate text-xs text-slate-500">
              {job.input_path} · {job.quality_label}
            </p>
          )}
        </div>
        <StatusBadge status={job.status} />
      </div>

      {(job.status === "running" || job.status === "queued") && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-xs text-slate-400">
            <span>
              {mb(job.bytes_processed)} / {mb(job.bytes_total)} MB
            </span>
            <span>{pct}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {job.error_message && (
        <p className="mt-3 rounded-md border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
          {job.error_message}
        </p>
      )}

      {job.status === "live" && job.output_path && (
        <p className="mt-3 text-xs text-emerald-300/90">
          Encryption complete · file saved at{" "}
          <code className="text-slate-300">{job.output_path}</code>.
        </p>
      )}
    </div>
  );
}

// --- Status badge -------------------------------------------------------------

function StatusBadge({ status }: { status: JobStatus }) {
  const styles: Record<JobStatus, string> = {
    queued: "bg-slate-700 text-slate-200",
    running: "bg-blue-700 text-blue-100",
    awaiting_urls: "bg-amber-700 text-amber-100",
    live: "bg-emerald-700 text-emerald-100",
    failed: "bg-red-700 text-red-100",
    cancelled: "bg-slate-800 text-slate-400",
  };
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${styles[status]}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
