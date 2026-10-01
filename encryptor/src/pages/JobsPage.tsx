import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { tauri } from "@/lib/tauri";
import { JobInfo } from "@/lib/types";
import { apiGet, apiPost } from "@/lib/rest";
import { Course } from "@/lib/admin-types";

// Folder icon SVG
function FolderIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  );
}

// Film/Video icon SVG
function VideoIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
  );
}

// Chevron icon SVG
function ChevronIcon({ className = "w-4 h-4", open = false }: { className?: string; open?: boolean }) {
  return (
    <svg className={`${className} transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

interface BatchCourseInfo {
  courseId: string | null;
  courseName: string;
  autoCreate: boolean;
  linkedVideos: string[];
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [mode, setMode] = useState<"single" | "folder">("single");

  // Single-file state
  const [pickedFile, setPickedFile] = useState<string | null>(null);
  const [customTitle, setCustomTitle] = useState("");
  const [singleSubmitting, setSingleSubmitting] = useState(false);
  const [singleError, setSingleError] = useState("");

  // Folder batch state
  const [batch, setBatch] = useState<{
    folderPath: string | null;
    batchName: string;
    autoCreateCourse: boolean;
    submitting: boolean;
    error: string;
    successMessage: string;
  }>({
    folderPath: null,
    batchName: "",
    autoCreateCourse: true,
    submitting: false,
    error: "",
    successMessage: "",
  });

  // Batch to Course mapping (persisted in localStorage)
  const [batchCourseMap, setBatchCourseMap] = useState<Record<string, BatchCourseInfo>>(() => {
    try {
      const saved = localStorage.getItem("svp_batch_course_map");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const saveBatchCourseMap = (updater: (prev: Record<string, BatchCourseInfo>) => Record<string, BatchCourseInfo>) => {
    setBatchCourseMap((prev) => {
      const next = updater(prev);
      try {
        localStorage.setItem("svp_batch_course_map", JSON.stringify(next));
      } catch (e) {
        console.error("Failed to save batch course map:", e);
      }
      return next;
    });
  };

  // Poll / listen for job updates
  const loadJobs = useCallback(async () => {
    try {
      const list = await tauri.listJobs();
      setJobs(list);
    } catch (e) {
      console.error("list_jobs error:", e);
    }
  }, []);

  useEffect(() => {
    loadJobs();
    const interval = setInterval(loadJobs, 2000);
    return () => clearInterval(interval);
  }, [loadJobs]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    tauri.onJobUpdate((job) => {
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === job.id);
        if (idx === -1) return [job, ...prev];
        const next = [...prev];
        next[idx] = job;
        return next;
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Auto-link completed live videos to their assigned course
  const linkedVideosRef = useRef<Set<string>>(new Set());

  const linkVideoToCourse = useCallback(
    async (batchId: string, videoId: string) => {
      const info = batchCourseMap[batchId];
      if (!info || !info.courseId || !info.autoCreate) return;

      const cacheKey = `${info.courseId}:${videoId}`;
      if (linkedVideosRef.current.has(cacheKey)) return;
      linkedVideosRef.current.add(cacheKey);

      try {
        await apiPost(`/api/admin/courses/${info.courseId}/videos`, {
          video_id: videoId,
          display_order: null,
        });
        saveBatchCourseMap((prev) => {
          const cur = prev[batchId];
          if (!cur) return prev;
          if (cur.linkedVideos.includes(videoId)) return prev;
          return {
            ...prev,
            [batchId]: {
              ...cur,
              linkedVideos: [...cur.linkedVideos, videoId],
            },
          };
        });
      } catch (err) {
        console.error(`Failed to link video ${videoId} to course ${info.courseId}:`, err);
      }
    },
    [batchCourseMap],
  );

  useEffect(() => {
    jobs.forEach((j) => {
      if (j.status === "live" && j.batch_id && batchCourseMap[j.batch_id]) {
        linkVideoToCourse(j.batch_id, j.video_id);
      }
    });
  }, [jobs, batchCourseMap, linkVideoToCourse]);

  // Single-file handlers
  const pickSingleFile = async () => {
    setSingleError("");
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Video", extensions: ["mp4", "mkv", "mov", "avi", "wmv", "webm", "m4v"] }],
      });
      if (typeof selected === "string") {
        setPickedFile(selected);
        if (!customTitle) {
          const base = selected.replace(/\\/g, "/").split("/").pop() || "";
          const stem = base.replace(/\.[^.]+$/, "");
          setCustomTitle(stem);
        }
      }
    } catch (e) {
      setSingleError(e instanceof Error ? e.message : "Failed to pick file");
    }
  };

  const startSingleJob = async () => {
    if (!pickedFile) return;
    setSingleSubmitting(true);
    setSingleError("");
    try {
      const base = pickedFile.replace(/\\/g, "/").split("/").pop() || "video";
      const autoTitle = base.lastIndexOf(".") !== -1 ? base.substring(0, base.lastIndexOf(".")) : base;
      const title = customTitle.trim() || autoTitle || "video";
      const job = await tauri.startEncryptionJob(pickedFile, title);
      setJobs((prev) => [job, ...prev]);
      setPickedFile(null);
      setCustomTitle("");
    } catch (e) {
      setSingleError(e instanceof Error ? e.message : "Failed to start job");
    } finally {
      setSingleSubmitting(false);
    }
  };

  // Folder batch handlers
  const pickFolder = async () => {
    setBatch((b) => ({ ...b, error: "", successMessage: "" }));
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Select folder with videos to encrypt",
      });
      if (typeof selected === "string") {
        const folderName = selected.replace(/\\/g, "/").split("/").pop() || "Batch";
        setBatch((b) => ({
          ...b,
          folderPath: selected,
          batchName: b.batchName || folderName,
        }));
      }
    } catch (e) {
      setBatch((b) => ({
        ...b,
        error: e instanceof Error ? e.message : "Failed to open folder picker",
      }));
    }
  };

  const startBatchJobs = async () => {
    if (!batch.folderPath) return;
    setBatch((b) => ({ ...b, submitting: true, error: "", successMessage: "" }));

    const batchName = batch.batchName.trim() || (batch.folderPath ? batch.folderPath.replace(/\\/g, "/").split("/").pop() : "Batch") || "Batch";
    let targetCourseId: string | null = null;

    try {
      // Step 1: If autoCreateCourse is enabled, check or create the course
      if (batch.autoCreateCourse) {
        try {
          const existingCourses = await apiGet<Course[]>("/api/admin/courses");
          const found = existingCourses.find(
            (c) => c.name.toLowerCase() === batchName.toLowerCase(),
          );
          if (found) {
            targetCourseId = found.id;
          } else {
            const created = await apiPost<Course>("/api/admin/courses", {
              name: batchName,
              description: `Batch imported from folder ${batchName}`,
              tags: [],
            });
            targetCourseId = created.id;
          }
        } catch (courseErr) {
          console.error("Course creation warning:", courseErr);
          // Don't abort encryption if course creation network fails, just warn
        }
      }

      // Step 2: Queue all videos in the folder for encryption
      const result = await tauri.startFolderBatch(batch.folderPath, batchName);

      // Step 3: Register batch in batchCourseMap
      saveBatchCourseMap((prev) => ({
        ...prev,
        [result.batch_id]: {
          courseId: targetCourseId,
          courseName: batchName,
          autoCreate: batch.autoCreateCourse,
          linkedVideos: [],
        },
      }));

      // Update state with newly queued jobs
      setJobs((prev) => {
        const newIds = new Set(result.jobs.map((j) => j.id));
        const kept = prev.filter((j) => !newIds.has(j.id));
        return [...result.jobs, ...kept];
      });

      const courseMsg = batch.autoCreateCourse && targetCourseId
        ? ` Course "${batchName}" linked.`
        : "";
      setBatch({
        folderPath: null,
        batchName: "",
        autoCreateCourse: true,
        submitting: false,
        error: "",
        successMessage: `Queued ${result.queued} video(s) from "${batchName}".${result.skipped > 0 ? ` (${result.skipped} non-video files skipped)` : ""}${courseMsg}`,
      });
    } catch (e) {
      setBatch((b) => ({
        ...b,
        submitting: false,
        error: e instanceof Error ? e.message : "Failed to start folder batch",
      }));
    }
  };

  const cancelJob = async (jobId: string) => {
    try {
      await tauri.cancelJob(jobId);
    } catch (e) {
      console.error("Failed to cancel job:", e);
    }
  };

  // Split jobs into active and history
  const activeJobs = jobs.filter((j) => j.status === "queued" || j.status === "running");
  const historyJobs = jobs.filter((j) => j.status !== "queued" && j.status !== "running");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Encryption jobs</h1>
          <p className="text-sm text-slate-400">
            Encrypt videos into offline-secure .svf format and register with the server.
          </p>
        </div>

        {/* Tab Toggle: Single Video vs Folder Batch */}
        <div className="flex rounded-lg bg-slate-900 p-1 border border-slate-800">
          <button
            type="button"
            onClick={() => setMode("single")}
            className={`flex items-center gap-2 rounded-md px-3.5 py-1.5 text-xs font-semibold transition ${
              mode === "single"
                ? "bg-indigo-600 text-white shadow"
                : "text-slate-400 hover:text-white"
            }`}
          >
            <VideoIcon className="w-3.5 h-3.5" />
            Single video
          </button>
          <button
            type="button"
            onClick={() => setMode("folder")}
            className={`flex items-center gap-2 rounded-md px-3.5 py-1.5 text-xs font-semibold transition ${
              mode === "folder"
                ? "bg-indigo-600 text-white shadow"
                : "text-slate-400 hover:text-white"
            }`}
          >
            <FolderIcon className="w-3.5 h-3.5" />
            Folder Batch
          </button>
        </div>
      </div>

      {/* Mode A: Single Video Form */}
      {mode === "single" && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-200">Start a single video encryption</h2>
          {singleError && (
            <p className="rounded-md border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
              {singleError}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={pickSingleFile}
              className="rounded-lg bg-slate-800 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700 transition"
            >
              {pickedFile ? "Change file..." : "Pick video file..."}
            </button>
            <span className="text-xs text-slate-400 truncate max-w-lg">
              {pickedFile || "No file selected"}
            </span>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Video title (optional)
            </label>
            <input
              type="text"
              value={customTitle}
              onChange={(e) => setCustomTitle(e.target.value)}
              placeholder="Defaults to filename without extension"
              className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <p className="text-xs text-slate-500">
            Resolution and quality label are auto-detected from dimensions. The file is encrypted directly without transcoding.
          </p>

          <button
            type="button"
            disabled={!pickedFile || singleSubmitting}
            onClick={startSingleJob}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition"
          >
            {singleSubmitting ? "Starting..." : "Start encryption"}
          </button>
        </div>
      )}

      {/* Mode B: Folder Batch Form */}
      {mode === "folder" && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-200">Encrypt an entire folder</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Pick a folder - every video inside will be encrypted automatically. The folder name is used as the batch name.
            </p>
          </div>

          {batch.error && (
            <p className="rounded-md border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
              {batch.error}
            </p>
          )}

          {batch.successMessage && (
            <p className="rounded-md border border-emerald-900 bg-emerald-950/80 px-3 py-2 text-xs text-emerald-300">
              {batch.successMessage}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={pickFolder}
              className="flex items-center gap-2 rounded-lg bg-slate-800 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700 transition"
            >
              <FolderIcon className="w-3.5 h-3.5" />
              {batch.folderPath ? "Change folder..." : "Pick folder..."}
            </button>
            <span className="text-xs text-slate-400 truncate max-w-lg">
              {batch.folderPath || "No folder selected"}
            </span>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Batch name
            </label>
            <input
              type="text"
              value={batch.batchName}
              onChange={(e) => setBatch((b) => ({ ...b, batchName: e.target.value }))}
              placeholder="Auto-filled from folder name"
              className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <p className="text-xs text-slate-500 mt-1">
              You can edit this - it is how the batch will appear in your job history.
            </p>
          </div>

          {/* Course Auto-Creation Toggle */}
          <div className="pt-1">
            <label className="flex items-start gap-3 cursor-pointer p-3.5 rounded-lg bg-slate-950/80 border border-slate-800 hover:border-slate-700 transition">
              <input
                type="checkbox"
                checked={batch.autoCreateCourse}
                onChange={(e) => setBatch((b) => ({ ...b, autoCreateCourse: e.target.checked }))}
                className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-indigo-500"
              />
              <div className="flex-1">
                <span className="text-xs font-semibold text-slate-200 flex items-center gap-2">
                  Automatically create Course and link all videos
                  {batch.autoCreateCourse && (
                    <span className="rounded bg-indigo-900/60 px-2 py-0.5 text-[10px] text-indigo-300 border border-indigo-700/50">
                      Auto-Course Enabled
                    </span>
                  )}
                </span>
                <p className="text-xs text-slate-400 mt-1">
                  {batch.autoCreateCourse
                    ? `A new Course named "${batch.batchName || "your folder name"}" will be created (or linked if it exists), and every video will be attached to it upon encryption.`
                    : "Videos will only be encrypted in bulk. No course will be created, allowing you to assign them to courses manually later."}
                </p>
              </div>
            </label>
          </div>

          <button
            type="button"
            disabled={!batch.folderPath || batch.submitting}
            onClick={startBatchJobs}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition"
          >
            <FolderIcon className="w-3.5 h-3.5" />
            {batch.submitting ? "Queuing videos..." : "Start batch encryption"}
          </button>
        </div>
      )}

      {/* Active Jobs Section */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-400">
          Active ({activeJobs.length})
        </h2>
        {activeJobs.length === 0 ? (
          <p className="text-xs text-slate-500">No active encryption jobs.</p>
        ) : (
          <JobGroupedList
            jobs={activeJobs}
            onCancel={cancelJob}
            batchCourseMap={batchCourseMap}
          />
        )}
      </div>

      {/* History Section */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-400">
          History ({historyJobs.length})
        </h2>
        {historyJobs.length === 0 ? (
          <p className="text-xs text-slate-500">No completed jobs yet.</p>
        ) : (
          <JobGroupedList
            jobs={historyJobs}
            batchCourseMap={batchCourseMap}
          />
        )}
      </div>
    </div>
  );
}

// Group jobs by batch_id
function JobGroupedList({
  jobs,
  onCancel,
  batchCourseMap,
}: {
  jobs: JobInfo[];
  onCancel?: (id: string) => void;
  batchCourseMap: Record<string, BatchCourseInfo>;
}) {
  const { singles, batches } = useMemo(() => {
    const singles: JobInfo[] = [];
    const batches = new Map<string, JobInfo[]>();

    for (const job of jobs) {
      if (job.batch_id) {
        const existing = batches.get(job.batch_id) || [];
        existing.push(job);
        batches.set(job.batch_id, existing);
      } else {
        singles.push(job);
      }
    }
    return { singles, batches };
  }, [jobs]);

  return (
    <div className="space-y-4">
      {/* Batch Groups */}
      {Array.from(batches.entries()).map(([batchId, batchJobs]) => (
        <BatchGroupCard
          key={batchId}
          batchId={batchId}
          jobs={batchJobs}
          onCancel={onCancel}
          courseInfo={batchCourseMap[batchId]}
        />
      ))}

      {/* Single Jobs */}
      {singles.map((job) => (
        <JobCard key={job.id} job={job} onCancel={onCancel} />
      ))}
    </div>
  );
}

// Collapsible Batch Group Card
function BatchGroupCard({
  batchId: _batchId,
  jobs,
  onCancel,
  courseInfo,
}: {
  batchId: string;
  jobs: JobInfo[];
  onCancel?: (id: string) => void;
  courseInfo?: BatchCourseInfo;
}) {
  const [open, setOpen] = useState(true);

  const batchName = jobs[0]?.batch_name || "Batch";
  const total = jobs.length;
  const completed = jobs.filter((j) => j.status === "live").length;
  const running = jobs.filter((j) => j.status === "running").length;
  const queued = jobs.filter((j) => j.status === "queued").length;
  const failed = jobs.filter((j) => j.status === "failed").length;

  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const isFinished = running === 0 && queued === 0;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden">
      {/* Batch Header Bar */}
      <div
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-between px-4 py-3 bg-slate-800/40 hover:bg-slate-800/60 cursor-pointer select-none transition"
      >
        <div className="flex items-center gap-3">
          <FolderIcon className="w-5 h-5 text-indigo-400 flex-shrink-0" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">{batchName}</span>
              <span className="text-xs text-slate-400">
                ({completed}/{total} completed)
              </span>

              {/* Course Assignment Badge */}
              {courseInfo?.autoCreate && courseInfo.courseId ? (
                <span className="rounded bg-indigo-950 px-2 py-0.5 text-[10px] font-medium text-indigo-300 border border-indigo-800">
                  Course: {courseInfo.courseName} ({courseInfo.linkedVideos.length}/{total} added)
                </span>
              ) : courseInfo && !courseInfo.autoCreate ? (
                <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-400 border border-slate-700">
                  Unassigned (Encrypt only)
                </span>
              ) : null}
            </div>

            <p className="text-[11px] text-slate-400 mt-0.5">
              {running > 0 && `${running} running · `}
              {queued > 0 && `${queued} queued · `}
              {failed > 0 && `${failed} failed · `}
              {isFinished ? "Batch complete" : "Batch in progress"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Progress Bar */}
          <div className="w-32 bg-slate-800 rounded-full h-2 overflow-hidden hidden sm:block">
            <div
              className={`h-2 transition-all duration-300 ${
                isFinished && failed === 0 ? "bg-emerald-500" : "bg-indigo-500"
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="text-xs font-semibold text-slate-300 w-10 text-right">
            {percent}%
          </span>
          <ChevronIcon className="w-4 h-4 text-slate-400" open={open} />
        </div>
      </div>

      {/* Expanded Jobs List */}
      {open && (
        <div className="divide-y divide-slate-800/60 p-2 space-y-2">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} onCancel={onCancel} isNested />
          ))}
        </div>
      )}
    </div>
  );
}

// Single Job Item
function JobCard({
  job,
  onCancel,
  isNested = false,
}: {
  job: JobInfo;
  onCancel?: (id: string) => void;
  isNested?: boolean;
}) {
  const percent =
    job.bytes_total > 0
      ? Math.min(100, Math.round((job.bytes_processed / job.bytes_total) * 100))
      : 0;

  const mbProcessed = (job.bytes_processed / (1024 * 1024)).toFixed(1);
  const mbTotal = (job.bytes_total / (1024 * 1024)).toFixed(1);

  return (
    <div
      className={`rounded-lg border p-4 space-y-2 transition ${
        isNested
          ? "border-slate-800/60 bg-slate-950/40"
          : "border-slate-800 bg-slate-900/60"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">{job.title}</span>
            <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400 font-mono">
              {job.quality_label}
            </span>
          </div>
          <p className="text-xs text-slate-500 truncate max-w-xl mt-0.5">
            {job.input_path}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <StatusBadge status={job.status} />
          {job.status === "running" && onCancel && (
            <button
              type="button"
              onClick={() => onCancel(job.id)}
              className="text-xs text-rose-400 hover:text-rose-300 px-2 py-1 rounded bg-rose-950/50 border border-rose-900 transition"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {job.status === "running" && (
        <div className="space-y-1 pt-1">
          <div className="flex justify-between text-xs text-slate-400">
            <span>
              {mbProcessed} / {mbTotal} MB
            </span>
            <span className="font-semibold">{percent}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-indigo-500 transition-all duration-200"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )}

      {job.status === "live" && job.output_path && (
        <p className="text-xs text-emerald-400">
          Encryption complete - file saved at {job.output_path}
        </p>
      )}

      {job.status === "failed" && job.error_message && (
        <p className="text-xs text-red-400">{job.error_message}</p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    queued: "bg-slate-800 text-slate-300 border-slate-700",
    running: "bg-indigo-950 text-indigo-300 border-indigo-800",
    live: "bg-emerald-950 text-emerald-300 border-emerald-800",
    failed: "bg-red-950 text-red-300 border-red-800",
    cancelled: "bg-amber-950 text-amber-300 border-amber-800",
  };
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium border ${
        styles[status] || "bg-slate-800 text-slate-400 border-slate-700"
      }`}
    >
      {status}
    </span>
  );
}
