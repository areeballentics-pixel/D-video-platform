import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";

type AuthMode = "email" | "license-key";

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, loginWithKey, error, clearError } = useAuthStore();
  const [mode, setMode] = useState<AuthMode>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setLoading(true);

    try {
      if (mode === "email") {
        await login(email, password);
      } else {
        await loginWithKey(licenseKey);
      }
      navigate("/library");
    } catch {
      // Error is set in the store
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="w-full max-w-md rounded-xl bg-[var(--color-surface)] p-8 shadow-2xl">
        <h1 className="mb-2 text-center text-2xl font-bold">SecurePlayer</h1>
        <p className="mb-6 text-center text-sm text-[var(--color-text-muted)]">
          Sign in to access your videos
        </p>

        {/* Auth Mode Tabs */}
        <div className="mb-6 flex rounded-lg bg-[var(--color-bg)] p-1">
          <button
            onClick={() => { setMode("email"); clearError(); }}
            className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
              mode === "email"
                ? "bg-[var(--color-primary)] text-white"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            Email & Password
          </button>
          <button
            onClick={() => { setMode("license-key"); clearError(); }}
            className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
              mode === "license-key"
                ? "bg-[var(--color-primary)] text-white"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            License Key
          </button>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          {mode === "email" ? (
            <>
              <input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
              />
            </>
          ) : (
            <input
              type="text"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              required
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-center font-mono text-sm tracking-widest text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
            />
          )}

          {error && (
            <p className="text-sm text-[var(--color-error)]">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[var(--color-primary)] py-3 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
