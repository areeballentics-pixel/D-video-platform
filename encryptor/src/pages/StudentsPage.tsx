import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPostForm } from "@/lib/rest";
import { Enrollment, Student } from "@/lib/admin-types";

interface Device {
  device_id: string;
  fingerprint: string;
  hostname: string;
  os_version: string;
  is_active: boolean;
  registered_at: string;
  last_seen_at: string;
}

export default function StudentsPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [creating, setCreating] = useState(false);

  const [managing, setManaging] = useState<Student | null>(null);

  // CSV bulk-import state
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvSummary, setCsvSummary] = useState<{
    total_rows: number;
    created_users: number;
    skipped_existing_users: number;
    enrollments_created: number;
    errors: string[];
  } | null>(null);

  const handleCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-uploading the same file
    if (!file) return;
    setCsvImporting(true);
    setCsvSummary(null);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const summary = await apiPostForm<{
        total_rows: number;
        created_users: number;
        skipped_existing_users: number;
        enrollments_created: number;
        errors: string[];
      }>("/api/admin/enrollments/import-csv", fd);
      setCsvSummary(summary);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "CSV import failed");
    } finally {
      setCsvImporting(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<{ students: Student[] }>("/api/admin/students");
      setStudents(data.students);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("email", newEmail);
      fd.append("password", newPassword);
      // /admin/students takes Form fields, not JSON. Server endpoint
      // predates the move to JSON bodies — `apiPostForm` is the escape hatch.
      await apiPostForm("/api/admin/students", fd);
      setShowCreate(false);
      setNewEmail("");
      setNewPassword("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const filtered = students.filter((s) =>
    !filter || s.email.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Students</h1>
          <p className="mt-1 text-sm text-slate-400">
            {students.length} students. Click any row to manage devices,
            enrollments, or reset password.
          </p>
        </div>
        <div className="flex gap-2">
          <label
            className={`cursor-pointer rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 ${
              csvImporting ? "opacity-50 pointer-events-none" : ""
            }`}
          >
            {csvImporting ? "Importing…" : "Import CSV"}
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={handleCsvImport}
              className="hidden"
            />
          </label>
          <button
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark"
          >
            + New student
          </button>
        </div>
      </div>

      {csvSummary && (
        <div className="rounded-md border border-emerald-700/40 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200">
          <p className="font-semibold">CSV import complete</p>
          <p className="mt-1 text-xs text-emerald-300/90">
            {csvSummary.total_rows} rows · {csvSummary.created_users} students
            created · {csvSummary.skipped_existing_users} skipped (already
            existed) · {csvSummary.enrollments_created} enrollments added
          </p>
          {csvSummary.errors.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-amber-300">
                {csvSummary.errors.length} warnings
              </summary>
              <ul className="mt-2 max-h-40 overflow-y-auto pl-4 font-mono">
                {csvSummary.errors.map((e, i) => (
                  <li key={i} className="text-amber-200">
                    {e}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="mt-2 text-xs text-slate-400">
            Format: CSV with header row{" "}
            <code>email,password,courses</code>. The{" "}
            <code>courses</code> column is comma-separated course names within
            quotes if needed.
          </p>
          <button
            onClick={() => setCsvSummary(null)}
            className="mt-2 text-xs text-emerald-300 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by email…"
        className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
      />

      {error && (
        <div className="rounded-md border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : filtered.length === 0 ? (
        <p className="rounded-2xl border border-slate-800 bg-slate-900 py-10 text-center text-sm text-slate-500">
          {students.length === 0
            ? "No students yet."
            : "No matches for this filter."}
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-xs uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-4 py-2.5 text-left">Email</th>
                <th className="px-4 py-2.5 text-left">License key</th>
                <th className="px-4 py-2.5 text-center">Devices</th>
                <th className="px-4 py-2.5 text-center">Status</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-950">
              {filtered.map((s) => (
                <tr key={s.user_id} className="hover:bg-slate-900">
                  <td className="px-4 py-2.5">{s.email}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-400">
                    {s.license_key}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    {s.active_devices} / {s.max_devices}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        s.is_active
                          ? "bg-emerald-700/40 text-emerald-200"
                          : "bg-red-700/40 text-red-200"
                      }`}
                    >
                      {s.is_active ? "active" : "inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => setManaging(s)}
                      className="rounded-md border border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-800"
                    >
                      Manage
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={create}
            className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6"
          >
            <h2 className="mb-4 text-lg font-bold">New student</h2>
            <p className="mb-4 text-xs text-slate-400">
              Credentials issued here work in the Player desktop app.
            </p>

            <label className="mb-1.5 block text-sm text-slate-400">Email</label>
            <input
              required
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="mb-3 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />

            <label className="mb-1.5 block text-sm text-slate-400">
              Initial password (≥8 chars)
            </label>
            <input
              required
              minLength={8}
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="mb-4 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                disabled={creating}
                className="flex-1 rounded-md border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating}
                className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}

      {managing && (
        <ManageStudentDrawer
          student={managing}
          onClose={() => {
            setManaging(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ─── Manage drawer per student ──────────────────────────────────────────────

function ManageStudentDrawer({
  student,
  onClose,
}: {
  student: Student;
  onClose: () => void;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [error, setError] = useState("");
  const [acting, setActing] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, e] = await Promise.all([
        apiGet<{ devices: Device[] }>(
          `/api/admin/students/${student.user_id}/devices`,
        ),
        apiGet<Enrollment[]>(
          `/api/admin/enrollments/by-student/${student.user_id}`,
        ),
      ]);
      setDevices(d.devices);
      setEnrollments(e);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [student.user_id]);

  useEffect(() => {
    load();
  }, [load]);

  const dereg = async (id: string) => {
    if (!confirm("Deregister this device? Student will need to log in again.")) return;
    setActing(id);
    try {
      await apiDelete(
        `/api/admin/students/${student.user_id}/devices/${id}`,
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deregister failed");
    } finally {
      setActing(null);
    }
  };

  const clearAllDevices = async () => {
    if (
      !confirm(
        "Deregister ALL of this student's devices? They'll need to log in fresh on every device.",
      )
    ) {
      return;
    }
    setActing("clear-all");
    try {
      await apiPost(
        `/api/admin/students/${student.user_id}/devices/clear`,
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clear failed");
    } finally {
      setActing(null);
    }
  };

  const revoke = async (id: string) => {
    if (!confirm("Revoke this enrollment?")) return;
    setActing(id);
    try {
      await apiDelete(`/api/admin/enrollments/${id}`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revoke failed");
    } finally {
      setActing(null);
    }
  };

  const doReset = async () => {
    if (resetPassword.length < 8) {
      setResetMsg("Password must be ≥8 chars");
      return;
    }
    setResetting(true);
    setResetMsg(null);
    try {
      await apiPost(`/api/admin/students/${student.user_id}/reset-password`, {
        new_password: resetPassword,
      });
      setResetMsg("Password reset.");
      setResetPassword("");
    } catch (err) {
      setResetMsg(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60">
      <div className="w-full max-w-2xl overflow-y-auto bg-slate-950 p-6 shadow-2xl">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">{student.email}</h2>
            <p className="text-xs text-slate-500 font-mono">
              {student.license_key}
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

        {/* Reset password */}
        <section className="mb-5 rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <h3 className="mb-2 text-sm font-semibold">Reset password</h3>
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="New password (≥8 chars)"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />
            <button
              onClick={doReset}
              disabled={resetting || resetPassword.length < 8}
              className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
            >
              {resetting ? "Resetting…" : "Reset"}
            </button>
          </div>
          {resetMsg && (
            <p className="mt-2 text-xs text-slate-400">{resetMsg}</p>
          )}
        </section>

        {/* Devices */}
        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              Devices ({devices.filter((d) => d.is_active).length} active /{" "}
              {student.max_devices})
            </h3>
            <button
              onClick={clearAllDevices}
              disabled={acting === "clear-all"}
              className="rounded-md border border-red-900/40 px-2.5 py-1 text-xs text-red-300 hover:bg-red-900/30 disabled:opacity-50"
            >
              Deregister all
            </button>
          </div>
          {devices.length === 0 ? (
            <p className="rounded-md border border-slate-800 py-6 text-center text-xs text-slate-500">
              No devices yet.
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border border-slate-800">
              {devices.map((d) => (
                <div
                  key={d.device_id}
                  className="flex items-center gap-3 border-b border-slate-800 bg-slate-900 px-3 py-2 text-sm last:border-0"
                >
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-slate-200">
                      {d.hostname || "(unnamed)"}{" "}
                      <span className="text-xs text-slate-500">
                        {d.os_version}
                      </span>
                    </p>
                    <p className="font-mono text-xs text-slate-500">
                      {d.fingerprint}
                    </p>
                  </div>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      d.is_active
                        ? "bg-emerald-700/40 text-emerald-200"
                        : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {d.is_active ? "active" : "deregistered"}
                  </span>
                  {d.is_active && (
                    <button
                      onClick={() => dereg(d.device_id)}
                      disabled={acting === d.device_id}
                      className="rounded-md border border-red-900/40 px-2 py-0.5 text-xs text-red-300 hover:bg-red-900/30 disabled:opacity-50"
                    >
                      Deregister
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Enrollments */}
        <section>
          <h3 className="mb-2 text-sm font-semibold">
            Enrolled courses ({enrollments.filter((e) => e.is_active).length})
          </h3>
          {enrollments.length === 0 ? (
            <p className="rounded-md border border-slate-800 py-6 text-center text-xs text-slate-500">
              Not enrolled in any course yet. Enroll from the Courses page.
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border border-slate-800">
              {enrollments.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-3 border-b border-slate-800 bg-slate-900 px-3 py-2 text-sm last:border-0"
                >
                  <span className="flex-1 truncate">{e.course_name}</span>
                  <span className="text-xs text-slate-500">
                    {new Date(e.enrolled_at).toLocaleDateString()}
                  </span>
                  {e.is_active ? (
                    <button
                      onClick={() => revoke(e.id)}
                      disabled={acting === e.id}
                      className="rounded-md border border-red-900/40 px-2 py-0.5 text-xs text-red-300 hover:bg-red-900/30 disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  ) : (
                    <span className="text-xs text-slate-500">revoked</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-10">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}
