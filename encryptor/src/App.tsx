import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { tauri } from "@/lib/tauri";
import { useAppStore } from "@/store/appStore";
import Sidebar from "@/components/Sidebar";
import LoginPage from "@/pages/LoginPage";
import RegisterEncryptorPage from "@/pages/RegisterEncryptorPage";
import JobsPage from "@/pages/JobsPage";
import CoursesPage from "@/pages/CoursesPage";
import StudentsPage from "@/pages/StudentsPage";
import EncryptorsPage from "@/pages/EncryptorsPage";
import AnalyticsPage from "@/pages/AnalyticsPage";
import AuditPage from "@/pages/AuditPage";
import AwaitingUploadPage from "@/pages/AwaitingUploadPage";
import SettingsPage from "@/pages/SettingsPage";

export default function App() {
  const { status, loading, refresh, upsertJob } = useAppStore();
  const location = useLocation();

  // Initial state load + subscribe to job updates from Rust.
  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    tauri.onJobUpdate((job) => upsertJob(job)).then((u) => (unlisten = u));
    return () => {
      unlisten?.();
    };
  }, [refresh, upsertJob]);

  if (loading || !status) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        Loading…
      </div>
    );
  }

  // Routing decision tree:
  //   - not authenticated → /login (only path allowed)
  //   - authenticated but no master key → /register-encryptor
  //   - fully set up → main app
  if (!status.authenticated) {
    return location.pathname === "/login" ? (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    ) : (
      <Navigate to="/login" replace />
    );
  }

  if (!status.master_key_loaded) {
    return location.pathname === "/register-encryptor" ? (
      <Routes>
        <Route
          path="/register-encryptor"
          element={<RegisterEncryptorPage />}
        />
        <Route path="*" element={<Navigate to="/register-encryptor" replace />} />
      </Routes>
    ) : (
      <Navigate to="/register-encryptor" replace />
    );
  }

  // Main shell
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-slate-950 p-8">
        <Routes>
          <Route path="/" element={<Navigate to="/jobs" replace />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/courses" element={<CoursesPage />} />
          <Route path="/students" element={<StudentsPage />} />
          <Route path="/encryptors" element={<EncryptorsPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/awaiting-upload" element={<AwaitingUploadPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/jobs" replace />} />
        </Routes>
      </main>
    </div>
  );
}
