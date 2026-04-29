import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { tauri } from "@/lib/tauri";
import { useAppStore } from "@/store/appStore";
import { RegisterEncryptorResult } from "@/lib/types";

type Step = "confirm-password" | "show-key" | "done";

export default function RegisterEncryptorPage() {
  const { refresh } = useAppStore();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("confirm-password");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RegisterEncryptorResult | null>(null);
  const [acked, setAcked] = useState(false);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await tauri.registerEncryptor(password);
      setResult(r);
      setStep("show-key");
    } catch (err) {
      setError(typeof err === "string" ? err : "Registration failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleAcked = async () => {
    setStep("done");
    await refresh();
    navigate("/", { replace: true });
  };

  if (step === "confirm-password") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-950 p-8">
        <form
          onSubmit={handleRegister}
          className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl"
        >
          <h1 className="mb-1 text-xl font-bold">Register this encryptor</h1>
          <p className="mb-4 text-sm text-slate-400">
            One-time setup. The server will hand back your tenant master key,
            which we'll store securely in this device's OS keychain. Only one
            encryptor seat is included by default — if your account allows
            more, you can register additional devices.
          </p>

          <p className="mb-4 rounded-md border border-amber-900 bg-amber-950 px-3 py-2 text-sm text-amber-200">
            Re-enter your password to confirm. The master key never leaves the
            server without two factors of trust.
          </p>

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
            {submitting ? "Registering…" : "Register"}
          </button>
        </form>
      </div>
    );
  }

  if (step === "show-key" && result) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-950 p-8">
        <div className="w-full max-w-2xl rounded-2xl border border-amber-700 bg-slate-900 p-8 shadow-xl">
          <h1 className="mb-1 text-xl font-bold text-amber-300">
            ⚠ Save your master key offline NOW
          </h1>
          <p className="mb-4 text-sm text-slate-400">
            We've stored this key in your OS keychain so the encryptor can use
            it on subsequent launches without asking you again. Write the hex
            on paper or save it in a password manager — if this laptop is
            lost or wiped, the offline backup is your only way to recover
            without re-registering a new device seat.
          </p>

          <div className="mb-4 break-all rounded-md border border-slate-700 bg-slate-950 p-4 font-mono text-sm text-emerald-300">
            {result.master_key_hex}
          </div>

          <p className="mb-4 text-xs text-slate-500">
            Encryptor device ID: {result.encryptor_device_id}
            <br />
            Seats: {result.seats_used} of {result.seats_total} used
          </p>

          <label className="mb-4 flex items-start gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={acked}
              onChange={(e) => setAcked(e.target.checked)}
              className="mt-1"
            />
            <span>
              I have saved the master key offline (paper / password manager)
              and understand the recovery flow.
            </span>
          </label>

          <button
            onClick={handleAcked}
            disabled={!acked}
            className="w-full rounded-md bg-primary px-3 py-2 font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  return null;
}
