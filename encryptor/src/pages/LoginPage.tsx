import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { tauri } from "@/lib/tauri";
import { useAppStore } from "@/store/appStore";

export default function LoginPage() {
  const { status, refresh } = useAppStore();
  const navigate = useNavigate();
  const [email, setEmail] = useState(status?.last_admin_email ?? "");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await tauri.login(email, password);
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError(typeof err === "string" ? err : "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-slate-950 p-8">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl"
      >
        <h1 className="mb-1 text-xl font-bold">SVP Encryptor</h1>
        <p className="mb-6 text-sm text-slate-400">
          Sign in with your tenant admin credentials.
        </p>

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-slate-400">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm focus:border-primary focus:outline-none"
            placeholder="admin@yourinstitute.com"
          />
        </label>

        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-slate-400">Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </label>

        {error && (
          <p className="mb-3 rounded-md border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-primary px-3 py-2 font-medium text-white hover:bg-primary-dark disabled:opacity-50"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
