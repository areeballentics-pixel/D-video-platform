// Courses + per-course management, all inside the encryptor app.
// First slice of the v1.5 migration moving the tenant-admin surface into
// the desktop app. Follow-on screens (Students, Settings, Analytics)
// arrive in subsequent turns.

import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/rest";
import {
  AdminVideo,
  Course,
  CourseVideo,
  Enrollment,
  Student,
} from "@/lib/admin-types";

export default function CoursesPage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [managing, setManaging] = useState<Course | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiGet<Course[]>(
        `/api/admin/courses?include_archived=${includeArchived}`,
      );
      setCourses(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [includeArchived]);

  useEffect(() => {
    load();
  }, [load]);

  const togglePublish = async (c: Course) => {
    setError("");
    try {
      const updated = await apiPost<Course>(
        c.is_published
          ? `/api/admin/courses/${c.id}/unpublish`
          : `/api/admin/courses/${c.id}/publish`,
      );
      setCourses((prev) => prev.map((x) => (x.id === c.id ? updated : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    }
  };

  const archive = async (c: Course) => {
    setError("");
    try {
      const updated = await apiPost<Course>(
        c.is_archived
          ? `/api/admin/courses/${c.id}/unarchive`
          : `/api/admin/courses/${c.id}/archive`,
      );
      setCourses((prev) => prev.map((x) => (x.id === c.id ? updated : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Archive failed");
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Courses</h1>
          <p className="text-sm text-slate-400">
            Group videos into courses, then enroll students.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark"
        >
          + New course
        </button>
      </div>

      <label className="inline-flex items-center gap-2 text-sm text-slate-400">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(e) => setIncludeArchived(e.target.checked)}
        />
        Include archived
      </label>

      {error && (
        <p className="rounded-md border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {loading ? (
        <p className="py-12 text-center text-sm text-slate-500">Loading…</p>
      ) : courses.length === 0 ? (
        <p className="rounded-2xl border border-slate-800 bg-slate-900 py-16 text-center text-sm text-slate-500">
          No courses yet.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {courses.map((c) => (
            <div
              key={c.id}
              className={`rounded-2xl border bg-slate-900 p-5 ${
                c.is_archived ? "border-slate-800 opacity-60" : "border-slate-800"
              }`}
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <p className="font-semibold">{c.name}</p>
                <span
                  className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${
                    c.is_archived
                      ? "bg-slate-800 text-slate-400"
                      : c.is_published
                      ? "bg-emerald-700 text-emerald-100"
                      : "bg-amber-700 text-amber-100"
                  }`}
                >
                  {c.is_archived
                    ? "Archived"
                    : c.is_published
                    ? "Published"
                    : "Draft"}
                </span>
              </div>
              {c.description && (
                <p className="mb-3 line-clamp-2 text-xs text-slate-400">
                  {c.description}
                </p>
              )}
              <p className="mb-3 text-xs text-slate-500">
                {c.video_count} videos · {c.enrollment_count} enrolled
              </p>
              <button
                onClick={() => setManaging(c)}
                className="mb-2 block w-full rounded-md bg-primary px-3 py-1.5 text-center text-xs font-semibold text-white hover:bg-primary-dark"
              >
                Manage videos & students →
              </button>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => togglePublish(c)}
                  disabled={c.is_archived}
                  className="rounded-md border border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-800 disabled:opacity-50"
                >
                  {c.is_published ? "Unpublish" : "Publish"}
                </button>
                <button
                  onClick={() => archive(c)}
                  className="rounded-md border border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-800"
                >
                  {c.is_archived ? "Unarchive" : "Archive"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateCourseModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      {managing && (
        <ManageCourseDrawer
          course={managing}
          onClose={() => {
            setManaging(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ─── Create course modal ────────────────────────────────────────────────────

function CreateCourseModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await apiPost("/api/admin/courses", {
        name,
        description,
        thumbnail_url: null,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6"
      >
        <h2 className="mb-4 text-lg font-semibold">New course</h2>
        <input
          required
          autoFocus
          placeholder="Course name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mb-3 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
        />
        <textarea
          placeholder="Description (optional)"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="mb-3 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
        />
        <input
          placeholder="Tags (comma separated)"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          className="mb-4 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
        />
        {error && (
          <p className="mb-3 rounded-md border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="flex-1 rounded-md border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Manage drawer (videos + students tabs) ─────────────────────────────────

function ManageCourseDrawer({
  course,
  onClose,
}: {
  course: Course;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"videos" | "students">("videos");
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-3xl flex-col border-l border-slate-800 bg-slate-950"
      >
        <div className="flex items-center justify-between border-b border-slate-800 p-5">
          <div>
            <h2 className="text-lg font-bold">{course.name}</h2>
            <p className="text-xs text-slate-500">
              Manage videos and enrolled students
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md border border-slate-700 px-3 py-1 text-sm hover:bg-slate-800"
          >
            Close
          </button>
        </div>

        <div className="flex gap-1 border-b border-slate-800 bg-slate-900 p-1">
          {(["videos", "students"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                tab === t
                  ? "bg-primary text-white"
                  : "text-slate-400 hover:bg-slate-800"
              }`}
            >
              {t === "videos" ? "Videos" : "Students"}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {tab === "videos" ? (
            <VideosTab courseId={course.id} />
          ) : (
            <StudentsTab courseId={course.id} />
          )}
        </div>
      </div>
    </div>
  );
}

function VideosTab({ courseId }: { courseId: string }) {
  const [inCourse, setInCourse] = useState<CourseVideo[]>([]);
  const [allVideos, setAllVideos] = useState<AdminVideo[]>([]);
  const [picker, setPicker] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [vs, all] = await Promise.all([
        apiGet<CourseVideo[]>(`/api/admin/courses/${courseId}/videos`),
        apiGet<{ videos: AdminVideo[] }>("/api/admin/videos"),
      ]);
      setInCourse(vs);
      setAllVideos(all.videos);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [courseId]);

  useEffect(() => {
    load();
  }, [load]);

  const inCourseIds = new Set(inCourse.map((v) => v.video_id));
  const available = allVideos.filter((v) => !inCourseIds.has(v.video_id));

  const add = async () => {
    if (!picker) return;
    setError("");
    try {
      await apiPost(`/api/admin/courses/${courseId}/videos`, {
        video_id: picker,
        display_order: null,
      });
      setPicker("");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Add failed");
    }
  };

  const remove = async (videoId: string) => {
    if (!confirm("Remove this video from the course?")) return;
    setError("");
    try {
      await apiDelete(`/api/admin/courses/${courseId}/videos/${videoId}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-md border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <p className="mb-2 text-sm font-medium">Add a video</p>
        {available.length === 0 ? (
          <p className="text-xs text-slate-500">
            All your tenant videos are already in this course.
          </p>
        ) : (
          <div className="flex gap-2">
            <select
              value={picker}
              onChange={(e) => setPicker(e.target.value)}
              className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            >
              <option value="">Pick a video to add…</option>
              {available.map((v) => (
                <option key={v.video_id} value={v.video_id}>
                  {v.title}
                </option>
              ))}
            </select>
            <button
              onClick={add}
              disabled={!picker}
              className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
            >
              Add
            </button>
          </div>
        )}
      </div>

      {inCourse.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900 py-10 text-center text-sm text-slate-500">
          No videos in this course yet.
        </p>
      ) : (
        <div className="space-y-2">
          {[...inCourse]
            .sort((a, b) => a.display_order - b.display_order)
            .map((v) => (
              <div
                key={v.video_id}
                className="flex items-center justify-between rounded-md border border-slate-800 bg-slate-900 p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{v.title}</p>
                  <p className="text-xs text-slate-500">
                    {v.qualities.join(", ") || "—"}{" "}
                    {v.is_free_preview ? "· free preview" : ""}
                  </p>
                </div>
                <button
                  onClick={() => remove(v.video_id)}
                  className="rounded-md border border-red-900 px-2.5 py-1 text-xs text-red-300 hover:bg-red-950"
                >
                  Remove
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function StudentsTab({ courseId }: { courseId: string }) {
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [enr, sl] = await Promise.all([
        apiGet<Enrollment[]>(
          `/api/admin/enrollments/by-course/${courseId}?active_only=true`,
        ),
        apiGet<{ students: Student[] }>("/api/admin/students"),
      ]);
      setEnrollments(enr);
      setStudents(sl.students);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [courseId]);

  useEffect(() => {
    load();
  }, [load]);

  const enrolledIds = new Set(enrollments.map((e) => e.user_id));
  const available = students.filter((s) => !enrolledIds.has(s.user_id));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const enroll = async () => {
    if (selected.size === 0) return;
    setError("");
    try {
      await apiPost("/api/admin/enrollments/bulk", {
        user_ids: Array.from(selected),
        course_ids: [courseId],
        expires_at: null,
      });
      setSelected(new Set());
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enroll failed");
    }
  };

  const revoke = async (id: string, email: string) => {
    if (!confirm(`Revoke ${email}'s access?`)) return;
    setError("");
    try {
      await apiDelete(`/api/admin/enrollments/${id}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revoke failed");
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-md border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">
            Enroll students ({selected.size} selected)
          </p>
          <button
            onClick={enroll}
            disabled={selected.size === 0}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
          >
            Enroll {selected.size || ""}
          </button>
        </div>
        {available.length === 0 ? (
          <p className="text-xs text-slate-500">
            All your students are already enrolled. Create more on the
            Students page (coming soon — for now use the web dashboard).
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto rounded-md border border-slate-800 bg-slate-950">
            {available.map((s) => (
              <label
                key={s.user_id}
                className="flex cursor-pointer items-center gap-3 border-b border-slate-800 px-3 py-2 text-sm last:border-0 hover:bg-slate-900"
              >
                <input
                  type="checkbox"
                  checked={selected.has(s.user_id)}
                  onChange={() => toggle(s.user_id)}
                />
                <span className="flex-1">{s.email}</span>
                <span className="font-mono text-xs text-slate-500">
                  {s.license_key.slice(0, 8)}…
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      {enrollments.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900 py-10 text-center text-sm text-slate-500">
          No active enrollments yet.
        </p>
      ) : (
        <div className="space-y-2">
          {enrollments.map((e) => (
            <div
              key={e.id}
              className="flex items-center justify-between rounded-md border border-slate-800 bg-slate-900 p-3"
            >
              <div>
                <p className="text-sm">{e.user_email}</p>
                <p className="text-xs text-slate-500">
                  Since{" "}
                  {new Date(e.enrolled_at).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </div>
              <button
                onClick={() => revoke(e.id, e.user_email)}
                className="rounded-md border border-red-900 px-2.5 py-1 text-xs text-red-300 hover:bg-red-950"
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
// Suppress unused-import warning if apiPatch isn't reached — helper kept
// for the upcoming Students/Settings screens.
export const __unused_apiPatch = apiPatch;
