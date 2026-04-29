import { useEffect, useState } from "react";
import { apiGet } from "@/lib/rest";
import { AdminVideo, Course, Student } from "@/lib/admin-types";

type Tab = "videos" | "courses" | "students";

interface VideoStats {
  video_id: string;
  title: string;
  duration_ms: number;
  unique_viewers: number;
  total_watch_time_ms: number;
  avg_watch_percent: number;
  completion_count: number;
  dropoff_buckets: number[];
}

interface CourseStats {
  course_id: string;
  name: string;
  enrollment_count: number;
  video_count: number;
  avg_completion_percent: number;
}

interface StudentStats {
  user_id: string;
  email: string;
  last_active_at: string | null;
  courses_enrolled: number;
  videos_watched: number;
  total_watch_time_ms: number;
}

const fmtTime = (ms: number) => {
  if (!ms) return "0m";
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const fmtRel = (iso: string | null) => {
  if (!iso) return "—";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
};

export default function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>("videos");
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Analytics</h1>
        <p className="mt-1 text-sm text-slate-400">
          Watch-event aggregates. Pick a row to drill in.
        </p>
      </div>

      <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1">
        {(["videos", "courses", "students"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
              tab === t
                ? "bg-primary text-white"
                : "text-slate-400 hover:bg-slate-800"
            }`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "videos" && <VideosPanel />}
      {tab === "courses" && <CoursesPanel />}
      {tab === "students" && <StudentsPanel />}
    </div>
  );
}

function VideosPanel() {
  const [list, setList] = useState<AdminVideo[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [stats, setStats] = useState<VideoStats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiGet<{ videos: AdminVideo[] }>("/api/admin/videos")
      .then((r) => {
        setList(r.videos);
        if (r.videos[0]) setPick(r.videos[0].video_id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, []);

  useEffect(() => {
    if (!pick) return;
    setStats(null);
    apiGet<VideoStats>(`/api/admin/analytics/video/${pick}`)
      .then(setStats)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, [pick]);

  if (error) return <Err text={error} />;
  if (list.length === 0)
    return <Empty text="No videos yet. Encrypt one to see analytics." />;

  return (
    <>
      <select
        value={pick ?? ""}
        onChange={(e) => setPick(e.target.value)}
        className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
      >
        {list.map((v) => (
          <option key={v.video_id} value={v.video_id}>
            {v.title}
          </option>
        ))}
      </select>

      {stats && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Unique viewers" value={stats.unique_viewers} />
            <Stat
              label="Avg watch %"
              value={`${stats.avg_watch_percent.toFixed(0)}%`}
            />
            <Stat
              label="Completed (≥90%)"
              value={stats.completion_count}
              positive={stats.completion_count > 0}
            />
            <Stat
              label="Total time"
              value={fmtTime(stats.total_watch_time_ms)}
            />
          </div>
          <Dropoff buckets={stats.dropoff_buckets} />
        </>
      )}
    </>
  );
}

function CoursesPanel() {
  const [list, setList] = useState<Course[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [stats, setStats] = useState<CourseStats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiGet<Course[]>("/api/admin/courses")
      .then((cs) => {
        setList(cs);
        if (cs[0]) setPick(cs[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, []);

  useEffect(() => {
    if (!pick) return;
    setStats(null);
    apiGet<CourseStats>(`/api/admin/analytics/course/${pick}`)
      .then(setStats)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, [pick]);

  if (error) return <Err text={error} />;
  if (list.length === 0) return <Empty text="No courses yet." />;

  return (
    <>
      <select
        value={pick ?? ""}
        onChange={(e) => setPick(e.target.value)}
        className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
      >
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      {stats && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <Stat label="Enrolled" value={stats.enrollment_count} />
          <Stat label="Videos" value={stats.video_count} />
          <Stat
            label="Avg completion"
            value={`${stats.avg_completion_percent.toFixed(0)}%`}
            positive={stats.avg_completion_percent >= 70}
          />
        </div>
      )}
    </>
  );
}

function StudentsPanel() {
  const [list, setList] = useState<Student[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [stats, setStats] = useState<StudentStats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiGet<{ students: Student[] }>("/api/admin/students")
      .then((r) => {
        setList(r.students);
        if (r.students[0]) setPick(r.students[0].user_id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, []);

  useEffect(() => {
    if (!pick) return;
    setStats(null);
    apiGet<StudentStats>(`/api/admin/analytics/student/${pick}`)
      .then(setStats)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, [pick]);

  if (error) return <Err text={error} />;
  if (list.length === 0) return <Empty text="No students yet." />;

  return (
    <>
      <select
        value={pick ?? ""}
        onChange={(e) => setPick(e.target.value)}
        className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
      >
        {list.map((s) => (
          <option key={s.user_id} value={s.user_id}>
            {s.email}
          </option>
        ))}
      </select>

      {stats && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Courses" value={stats.courses_enrolled} />
          <Stat label="Videos watched" value={stats.videos_watched} />
          <Stat
            label="Watch time"
            value={fmtTime(stats.total_watch_time_ms)}
          />
          <Stat
            label="Last active"
            value={fmtRel(stats.last_active_at)}
            positive={
              stats.last_active_at &&
              Date.now() - new Date(stats.last_active_at).getTime() <
                30 * 86_400_000
                ? true
                : undefined
            }
          />
        </div>
      )}
    </>
  );
}

// ─── Shared widgets ─────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  positive,
}: {
  label: string;
  value: number | string;
  positive?: boolean;
}) {
  const tone =
    positive === true
      ? "text-emerald-300"
      : positive === false
      ? "text-red-300"
      : "text-slate-100";
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 px-5 py-4">
      <div className="text-xs uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold ${tone}`}>{value}</div>
    </div>
  );
}

function Dropoff({ buckets }: { buckets: number[] }) {
  const max = Math.max(1, ...buckets);
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <p className="mb-3 text-sm font-semibold">Drop-off by decile</p>
      <div className="flex h-36 items-end gap-1.5">
        {buckets.map((count, i) => (
          <div key={i} className="flex flex-1 flex-col items-center">
            <div
              className="w-full rounded-t bg-primary/80"
              style={{
                height: `${(count / max) * 100}%`,
                minHeight: "2px",
              }}
              title={`${(i + 1) * 10}% of video: ${count} viewers`}
            />
            <span className="mt-1 text-[10px] text-slate-500">
              {(i + 1) * 10}%
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Unique viewers reaching at least each decile.
      </p>
    </div>
  );
}

function Err({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
      {text}
    </p>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-2xl border border-slate-800 bg-slate-900 py-10 text-center text-sm text-slate-500">
      {text}
    </p>
  );
}
