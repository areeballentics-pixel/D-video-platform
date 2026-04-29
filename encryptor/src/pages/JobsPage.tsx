import { useState } from "react";
import { tauri } from "@/lib/tauri";
import { useAppStore } from "@/store/appStore";
import { JobInfo, JobStatus } from "@/lib/types";

export default function JobsPage() {
  const { jobs, refresh } = useAppStore();
  const [pickedFile, setPickedFile] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePickFile = async () => {
    const path = await tauri.pickVideoFile();
    if (path) {
      setPickedFile(path);
      // Auto-fill title from the filename if blank.
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
      // Quality is auto-detected from MP4 dimensions; no manual override.
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

  const activeJobs = jobs.filter((j) =>
    ["queued", "running"].includes(j.status),
  );
  const otherJobs = jobs.filter(
    (j) => !["queued", "running"].includes(j.status),
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold">Encryption jobs</h1>

      {/* New job */}
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

      {/* Active */}
      {activeJobs.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-300">
            Active ({activeJobs.length})
          </h2>
          <div className="space-y-2">
            {activeJobs.map((j) => (
              <JobCard key={j.id} job={j} />
            ))}
          </div>
        </section>
      )}

      {/* History */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-300">
          History ({otherJobs.length})
        </h2>
        {otherJobs.length === 0 ? (
          <p className="text-sm text-slate-500">No completed jobs yet.</p>
        ) : (
          <div className="space-y-2">
            {otherJobs.map((j) => (
              <JobCard key={j.id} job={j} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function JobCard({ job }: { job: JobInfo }) {
  const pct =
    job.bytes_total > 0
      ? Math.min(100, Math.round((job.bytes_processed / job.bytes_total) * 100))
      : 0;
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

  return (
    <div className="rounded-md border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{job.title}</p>
          <p className="truncate text-xs text-slate-500">
            {job.input_path} · {job.quality_label}
          </p>
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
          <code className="text-slate-300">{job.output_path}</code>. Distribute
          by USB, Drive, email — whatever works. (Optional: paste a download
          URL on the Distribution page so the player auto-fetches.)
        </p>
      )}
    </div>
  );
}

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
