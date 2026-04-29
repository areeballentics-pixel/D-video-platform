import { create } from "zustand";
import { tauri } from "@/lib/tauri";
import { AppStatus, JobInfo } from "@/lib/types";

interface AppState {
  status: AppStatus | null;
  jobs: JobInfo[];
  loading: boolean;
  refresh: () => Promise<void>;
  upsertJob: (job: JobInfo) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  status: null,
  jobs: [],
  loading: true,

  refresh: async () => {
    set({ loading: true });
    try {
      const [status, jobs] = await Promise.all([
        tauri.getStatus(),
        tauri.listJobs(),
      ]);
      set({ status, jobs, loading: false });
    } catch (e) {
      console.error("refresh failed:", e);
      set({ loading: false });
    }
  },

  upsertJob: (job) => {
    const existing = get().jobs;
    const idx = existing.findIndex((j) => j.id === job.id);
    if (idx === -1) {
      set({ jobs: [job, ...existing] });
    } else {
      const next = [...existing];
      next[idx] = job;
      set({ jobs: next });
    }
  },
}));
