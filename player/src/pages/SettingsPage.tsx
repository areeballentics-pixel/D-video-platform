import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { getDeviceInfo, getAppVersion } from "../lib/tauri";
import type { DeviceInfo } from "../lib/types";

export default function SettingsPage() {
  const navigate = useNavigate();
  const { email, logout: doLogout } = useAuthStore();
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [version, setVersion] = useState("");

  useEffect(() => {
    getDeviceInfo().then(setDevice).catch(console.error);
    getAppVersion().then(setVersion).catch(console.error);
  }, []);

  async function handleLogout() {
    await doLogout();
    navigate("/login");
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-4">
        <button
          onClick={() => navigate("/library")}
          className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          &larr; Back
        </button>
        <h1 className="text-lg font-bold">Settings</h1>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {/* Account */}
          <section className="rounded-xl bg-[var(--color-surface)] p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Account
            </h2>
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--color-text-muted)]">Email</span>
              <span className="text-sm">{email || "Not signed in"}</span>
            </div>
          </section>

          {/* Device Info */}
          <section className="rounded-xl bg-[var(--color-surface)] p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Device
            </h2>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--color-text-muted)]">Fingerprint</span>
                <span className="font-mono text-xs text-[var(--color-text-muted)]">
                  {device ? `...${device.fingerprint.slice(-12)}` : "Loading..."}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--color-text-muted)]">Hostname</span>
                <span className="text-sm">{device?.hostname || "..."}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--color-text-muted)]">OS</span>
                <span className="text-sm">{device?.os_version || "..."}</span>
              </div>
            </div>
          </section>

          {/* Logout */}
          <button
            onClick={handleLogout}
            className="w-full rounded-lg border border-[var(--color-error)] py-3 text-sm font-medium text-[var(--color-error)] transition-colors hover:bg-[var(--color-error)] hover:text-white"
          >
            Sign Out
          </button>

          <p className="text-center text-xs text-[var(--color-text-muted)]">
            SecurePlayer v{version || "..."}
          </p>
        </div>
      </main>
    </div>
  );
}
