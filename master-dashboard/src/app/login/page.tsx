"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function MasterLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await api.login(email, password);
      router.push("/master");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Logo / brand */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-primary">
            {/* Shield icon — signifies platform-level administration */}
            <svg
              className="h-7 w-7 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-text-primary">
            Master Dashboard
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            Platform-level administration
          </p>
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            Restricted Access
          </div>
        </div>

        {/* Login card */}
        <div className="rounded-xl border border-border bg-bg-surface p-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <div className="rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
                {error}
              </div>
            )}

            <div>
              <label
                htmlFor="email"
                className="mb-1.5 block text-sm font-medium text-text-muted"
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder-text-muted/50 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
                placeholder="you@yourplatform.com"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-sm font-medium text-text-muted"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder-text-muted/50 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
                placeholder="Enter your password"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg
                    className="h-4 w-4 animate-spin"
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
                  Signing in...
                </span>
              ) : (
                "Sign in"
              )}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-text-muted">
          Platform admin access only. Tenant admins use a different dashboard.
        </p>
      </div>
    </div>
  );
}
