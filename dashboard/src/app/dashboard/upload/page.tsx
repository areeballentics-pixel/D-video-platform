"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { api, type JobStatus } from "@/lib/api";

interface TrackedJob {
  jobId: string;
  videoId: string;
  title: string;
  status: JobStatus;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  queued: { bg: "bg-blue-500/10", text: "text-blue-400", label: "Queued" },
  transcoding: { bg: "bg-warning/10", text: "text-warning", label: "Transcoding" },
  encrypting: { bg: "bg-orange/10", text: "text-orange", label: "Encrypting" },
  packaging: { bg: "bg-accent/10", text: "text-accent", label: "Packaging" },
  completed: { bg: "bg-success/10", text: "text-success", label: "Completed" },
  failed: { bg: "bg-error/10", text: "text-error", label: "Failed" },
};

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [qualities, setQualities] = useState<string[]>(["480p", "720p", "1080p"]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [jobs, setJobs] = useState<TrackedJob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollIntervals = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  // Clean up intervals on unmount
  useEffect(() => {
    return () => {
      pollIntervals.current.forEach((interval) => clearInterval(interval));
    };
  }, []);

  const toggleQuality = (q: string) => {
    setQualities((prev) =>
      prev.includes(q) ? prev.filter((x) => x !== q) : [...prev, q]
    );
  };

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) {
      const droppedFile = e.dataTransfer.files[0];
      setFile(droppedFile);
      if (!title) {
        setTitle(droppedFile.name.replace(/\.[^.]+$/, ""));
      }
    }
  }, [title]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      if (!title) {
        setTitle(selectedFile.name.replace(/\.[^.]+$/, ""));
      }
    }
  };

  const startPolling = useCallback((jobId: string) => {
    const interval = setInterval(async () => {
      try {
        const status = await api.getJobStatus(jobId);
        setJobs((prev) =>
          prev.map((j) => (j.jobId === jobId ? { ...j, status } : j))
        );
        if (status.status === "completed" || status.status === "failed") {
          clearInterval(interval);
          pollIntervals.current.delete(jobId);
        }
      } catch {
        // keep polling
      }
    }, 2000);
    pollIntervals.current.set(jobId, interval);
  }, []);

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !title || qualities.length === 0) return;

    setError("");
    setUploading(true);
    setUploadProgress(0);

    try {
      const result = await api.uploadVideo(file, title, qualities, (percent) => {
        setUploadProgress(percent);
      });

      // Add job to tracking list
      const initialStatus: JobStatus = {
        status: "queued",
        progress: 0,
        detail: "Waiting to start...",
      };
      setJobs((prev) => [
        {
          jobId: result.job_id,
          videoId: result.video_id,
          title,
          status: initialStatus,
        },
        ...prev,
      ]);

      // Start polling
      startPolling(result.job_id);

      // Reset form
      setFile(null);
      setTitle("");
      setUploadProgress(0);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024)
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  };

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">Upload Video</h1>
        <p className="mt-1 text-sm text-text-muted">
          Upload a video file for encryption and transcoding
        </p>
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

      {/* Upload form */}
      <form
        onSubmit={handleUpload}
        className="mb-8 rounded-xl border border-border bg-bg-surface p-6"
      >
        {/* Drag & drop area */}
        <div
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`relative mb-5 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 transition-colors ${
            dragActive
              ? "border-primary bg-primary/5"
              : file
                ? "border-success/50 bg-success/5"
                : "border-border hover:border-primary/50"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            onChange={handleFileChange}
            className="hidden"
          />

          {file ? (
            <>
              <svg
                className="mb-3 h-10 w-10 text-success"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p className="text-sm font-medium text-text-primary">
                {file.name}
              </p>
              <p className="mt-1 text-xs text-text-muted">
                {formatFileSize(file.size)}
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                className="mt-2 text-xs text-error hover:underline"
              >
                Remove
              </button>
            </>
          ) : (
            <>
              <svg
                className="mb-3 h-10 w-10 text-text-muted/40"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
                />
              </svg>
              <p className="text-sm font-medium text-text-primary">
                Drag & drop your video file here
              </p>
              <p className="mt-1 text-xs text-text-muted">
                or click to browse files
              </p>
            </>
          )}
        </div>

        {/* Title */}
        <div className="mb-5">
          <label className="mb-1.5 block text-sm font-medium text-text-muted">
            Video Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            placeholder="Enter video title"
            className="w-full rounded-lg border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder-text-muted/50 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
          />
        </div>

        {/* Quality selection */}
        <div className="mb-6">
          <label className="mb-2 block text-sm font-medium text-text-muted">
            Output Qualities
          </label>
          <div className="flex gap-3">
            {["480p", "720p", "1080p"].map((q) => (
              <label
                key={q}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors ${
                  qualities.includes(q)
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-text-muted hover:border-primary/30"
                }`}
              >
                <input
                  type="checkbox"
                  checked={qualities.includes(q)}
                  onChange={() => toggleQuality(q)}
                  className="sr-only"
                />
                <div
                  className={`flex h-4 w-4 items-center justify-center rounded border ${
                    qualities.includes(q)
                      ? "border-primary bg-primary"
                      : "border-border"
                  }`}
                >
                  {qualities.includes(q) && (
                    <svg
                      className="h-3 w-3 text-white"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4.5 12.75l6 6 9-13.5"
                      />
                    </svg>
                  )}
                </div>
                {q}
              </label>
            ))}
          </div>
        </div>

        {/* Upload progress */}
        {uploading && (
          <div className="mb-5">
            <div className="mb-1.5 flex items-center justify-between text-xs text-text-muted">
              <span>Uploading...</span>
              <span>{uploadProgress}%</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-bg-primary">
              <div
                className="animate-progress-stripe h-full rounded-full bg-primary transition-progress"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={!file || !title || qualities.length === 0 || uploading}
          className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {uploading ? "Uploading..." : "Upload & Encrypt Video"}
        </button>
      </form>

      {/* Active Jobs */}
      {jobs.length > 0 && (
        <div>
          <h2 className="mb-4 text-lg font-bold text-text-primary">
            Pipeline Jobs
          </h2>
          <div className="space-y-4">
            {jobs.map((job) => {
              const statusConfig = STATUS_COLORS[job.status.status] || STATUS_COLORS.queued;
              return (
                <div
                  key={job.jobId}
                  className="rounded-xl border border-border bg-bg-surface p-5"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-text-primary">
                      {job.title}
                    </h3>
                    <span
                      className={`inline-flex rounded-md px-2.5 py-1 text-xs font-semibold ${statusConfig.bg} ${statusConfig.text}`}
                    >
                      {statusConfig.label}
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div className="mb-2">
                    <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
                      <span>{job.status.detail}</span>
                      <span>{job.status.progress}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-bg-primary">
                      <div
                        className={`h-full rounded-full transition-progress ${
                          job.status.status === "completed"
                            ? "bg-success"
                            : job.status.status === "failed"
                              ? "bg-error"
                              : "bg-primary animate-progress-stripe"
                        }`}
                        style={{ width: `${job.status.progress}%` }}
                      />
                    </div>
                  </div>

                  {/* Completed message */}
                  {job.status.status === "completed" && (
                    <div className="mt-3 flex items-center gap-2 text-sm text-success">
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                      Video encrypted and registered. Ready for playback!
                    </div>
                  )}

                  {/* Job ID */}
                  <p className="mt-2 text-[10px] font-mono text-text-muted/50">
                    Job: {job.jobId}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
