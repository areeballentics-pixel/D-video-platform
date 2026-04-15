"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { api, type Device, type Student } from "@/lib/api";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function StudentsPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Add student modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [addingStudent, setAddingStudent] = useState(false);

  // Expanded student devices
  const [expandedStudent, setExpandedStudent] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [deregistering, setDeregistering] = useState<string | null>(null);

  const loadStudents = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.listStudents();
      setStudents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load students");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStudents();
  }, [loadStudents]);

  const handleAddStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setAddingStudent(true);

    try {
      const result = await api.createStudent(newEmail, newPassword);
      setStudents((prev) => [
        {
          user_id: result.user_id,
          email: result.email,
          license_key: result.license_key,
          is_active: true,
          max_devices: 2,
          active_devices: 0,
          created_at: new Date().toISOString(),
        },
        ...prev,
      ]);
      setShowAddModal(false);
      setNewEmail("");
      setNewPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add student");
    } finally {
      setAddingStudent(false);
    }
  };

  const toggleExpand = async (studentId: string) => {
    if (expandedStudent === studentId) {
      setExpandedStudent(null);
      setDevices([]);
      return;
    }

    setExpandedStudent(studentId);
    setLoadingDevices(true);
    try {
      const data = await api.listDevices(studentId);
      setDevices(data);
    } catch {
      setDevices([]);
    } finally {
      setLoadingDevices(false);
    }
  };

  const handleDeregister = async (studentId: string, deviceId: string) => {
    try {
      setDeregistering(deviceId);
      await api.deregisterDevice(studentId, deviceId);
      setDevices((prev) => prev.filter((d) => d.device_id !== deviceId));
      setStudents((prev) =>
        prev.map((s) =>
          s.user_id === studentId
            ? { ...s, active_devices: Math.max(0, s.active_devices - 1) }
            : s
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deregistration failed");
    } finally {
      setDeregistering(null);
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Students</h1>
          <p className="mt-1 text-sm text-text-muted">
            Manage student accounts and device registrations
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 4.5v15m7.5-7.5h-15"
            />
          </svg>
          Add Student
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          {error}
          <button
            onClick={() => setError("")}
            className="ml-2 font-semibold hover:underline"
          >
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
      {!loading && students.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-bg-surface py-20">
          <svg
            className="mb-4 h-16 w-16 text-text-muted/30"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
            />
          </svg>
          <p className="text-lg font-medium text-text-muted">
            No students yet
          </p>
          <p className="mt-1 text-sm text-text-muted/70">
            Add your first student to get started
          </p>
        </div>
      )}

      {/* Student table */}
      {!loading && students.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-bg-surface">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Email
                </th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                  License Key
                </th>
                <th className="px-5 py-3.5 text-center text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Devices
                </th>
                <th className="px-5 py-3.5 text-center text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Status
                </th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {students.map((student) => (
                // Fragment needs an explicit key here; the shorthand <> form
                // doesn't accept props. Each student row maps to two <tr>s
                // (the main row + the expanded devices row), so we can't
                // just attach the key to a single <tr> parent.
                <Fragment key={student.user_id}>
                  <tr
                    onClick={() => toggleExpand(student.user_id)}
                    className="cursor-pointer transition-colors hover:bg-bg-surface-hover"
                  >
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                          {student.email.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm font-medium text-text-primary">
                          {student.email}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <code className="rounded bg-bg-primary px-2 py-1 text-xs text-text-muted font-mono">
                        {student.license_key}
                      </code>
                    </td>
                    <td className="px-5 py-4 text-center">
                      <span className="text-sm text-text-primary">
                        {student.active_devices}
                        <span className="text-text-muted">
                          /{student.max_devices}
                        </span>
                      </span>
                    </td>
                    <td className="px-5 py-4 text-center">
                      <span
                        className={`inline-flex rounded-md px-2.5 py-1 text-xs font-semibold ${
                          student.is_active
                            ? "bg-success/10 text-success"
                            : "bg-error/10 text-error"
                        }`}
                      >
                        {student.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm text-text-muted">
                      {formatDate(student.created_at)}
                    </td>
                  </tr>

                  {/* Expanded devices */}
                  {expandedStudent === student.user_id && (
                    <tr>
                      <td colSpan={5} className="bg-bg-primary px-5 py-4">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
                          Registered Devices
                        </div>

                        {loadingDevices && (
                          <div className="flex items-center gap-2 py-3 text-sm text-text-muted">
                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                            Loading devices...
                          </div>
                        )}

                        {!loadingDevices && devices.length === 0 && (
                          <p className="py-3 text-sm text-text-muted/70">
                            No devices registered
                          </p>
                        )}

                        {!loadingDevices && devices.length > 0 && (
                          <div className="space-y-2">
                            {devices.map((device) => (
                              <div
                                key={device.device_id}
                                className="flex items-start justify-between gap-4 rounded-lg border border-border bg-bg-surface px-4 py-3"
                              >
                                <div className="min-w-0 flex-1">
                                  {/* Row 1: hostname + status badge */}
                                  <div className="flex items-center gap-2">
                                    <svg
                                      className="h-4 w-4 shrink-0 text-text-muted"
                                      fill="none"
                                      viewBox="0 0 24 24"
                                      stroke="currentColor"
                                      strokeWidth={1.5}
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25"
                                      />
                                    </svg>
                                    <p className="truncate text-sm font-medium text-text-primary">
                                      {device.hostname || "Unnamed device"}
                                    </p>
                                    <span
                                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                                        device.is_active
                                          ? "bg-success/10 text-success"
                                          : "bg-text-muted/10 text-text-muted"
                                      }`}
                                    >
                                      {device.is_active ? "active" : "inactive"}
                                    </span>
                                  </div>

                                  {/* Row 2: OS */}
                                  {device.os_version && (
                                    <p className="mt-1 text-xs text-text-muted">
                                      {device.os_version}
                                    </p>
                                  )}

                                  {/* Row 3: fingerprint */}
                                  <p className="mt-1 font-mono text-xs text-text-muted/80">
                                    <span className="text-text-muted">Fingerprint:</span>{" "}
                                    {device.fingerprint}
                                  </p>

                                  {/* Row 4: timestamps */}
                                  <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-text-muted">
                                    <span>
                                      Registered:{" "}
                                      <span className="text-text-primary/80">
                                        {formatDate(device.registered_at)}
                                      </span>
                                    </span>
                                    <span>
                                      Last seen:{" "}
                                      <span className="text-text-primary/80">
                                        {device.last_seen_at
                                          ? formatDate(device.last_seen_at)
                                          : "never"}
                                      </span>
                                    </span>
                                  </div>
                                </div>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeregister(
                                      student.user_id,
                                      device.device_id
                                    );
                                  }}
                                  disabled={!device.is_active || deregistering === device.device_id}
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-error/30 px-3 py-1.5 text-xs font-medium text-error transition-colors hover:bg-error/10 disabled:opacity-50"
                                >
                                  {deregistering === device.device_id ? (
                                    <>
                                      <svg
                                        className="h-3.5 w-3.5 animate-spin"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                      >
                                        <circle
                                          className="opacity-25"
                                          cx="12"
                                          cy="12"
                                          r="10"
                                          stroke="currentColor"
                                          strokeWidth="4"
                                        />
                                        <path
                                          className="opacity-75"
                                          fill="currentColor"
                                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                                        />
                                      </svg>
                                      Removing...
                                    </>
                                  ) : (
                                    "Deregister"
                                  )}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Student Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-xl border border-border bg-bg-surface p-6">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-lg font-bold text-text-primary">
                Add Student
              </h2>
              <button
                onClick={() => {
                  setShowAddModal(false);
                  setNewEmail("");
                  setNewPassword("");
                }}
                className="rounded-lg p-1 text-text-muted transition-colors hover:bg-bg-surface-hover"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <form onSubmit={handleAddStudent} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-muted">
                  Email
                </label>
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="student@example.com"
                  className="w-full rounded-lg border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder-text-muted/50 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-muted">
                  Password
                </label>
                <input
                  type="password"
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Set a password"
                  className="w-full rounded-lg border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder-text-muted/50 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddModal(false);
                    setNewEmail("");
                    setNewPassword("");
                  }}
                  className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-text-muted transition-colors hover:bg-bg-surface-hover"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addingStudent}
                  className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
                >
                  {addingStudent ? "Adding..." : "Add Student"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
