// Typed wrappers around Tauri's invoke() — keeps page components from
// guessing at command names or argument shapes.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AppStatus,
  JobInfo,
  LoginResult,
  RegisterEncryptorResult,
} from "./types";

export const tauri = {
  // ── App state ──
  getStatus: () => invoke<AppStatus>("get_status"),
  getAppVersion: () => invoke<string>("get_app_version"),

  // ── Auth + registration ──
  login: (email: string, password: string) =>
    invoke<LoginResult>("login", { email, password }),
  registerEncryptor: (password: string) =>
    invoke<RegisterEncryptorResult>("register_encryptor", { password }),
  refreshMasterKey: (password: string) =>
    invoke<void>("refresh_master_key", { password }),
  logout: () => invoke<void>("logout"),
  forgetMasterKey: () => invoke<void>("forget_master_key"),

  // ── Jobs ──
  listJobs: () => invoke<JobInfo[]>("list_jobs"),
  startEncryptionJob: (
    inputPath: string,
    title: string,
    qualityLabel?: string,
    existingVideoId?: string,
  ) =>
    invoke<JobInfo>("start_encryption_job", {
      input: {
        input_path: inputPath,
        title,
        quality_label: qualityLabel ?? null,
        existing_video_id: existingVideoId ?? null,
      },
    }),
  cancelJob: (jobId: string) => invoke<void>("cancel_job", { jobId }),
  startFolderBatch: (folderPath: string, batchName?: string) =>
    invoke<{ batch_id: string; batch_name: string; queued: number; skipped: number; jobs: JobInfo[] }>("start_folder_batch", {
      input: { folder_path: folderPath, batch_name: batchName ?? null },
    }),
  submitDownloadUrls: (jobId: string, urls: Record<string, string>) =>
    invoke<JobInfo>("submit_download_urls", { input: { job_id: jobId, urls } }),

  // ── Settings ──
  setSettings: (settings: {
    server_url?: string;
    output_dir?: string;
    max_concurrent_jobs?: number;
  }) => invoke<void>("set_settings", { input: settings }),

  // ── Events ──
  onJobUpdate: (cb: (job: JobInfo) => void): Promise<UnlistenFn> =>
    listen<JobInfo>("job:update", (e) => cb(e.payload)),

  // ── File picker (Tauri dialog plugin) ──
  pickVideoFile: () =>
    openDialog({
      multiple: false,
      filters: [
        {
          name: "Video files",
          extensions: ["mp4", "mkv", "mov", "avi", "wmv", "webm", "m4v"],
        },
      ],
    }) as Promise<string | null>,
  pickFolder: () =>
    openDialog({ directory: true, multiple: false }) as Promise<string | null>,
};
