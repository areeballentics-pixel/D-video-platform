"use client";

import { useEffect, useState } from "react";
import { api, type TotpEnableResponse } from "@/lib/api";

type State =
  | { phase: "loading" }
  | { phase: "enabled" }
  | { phase: "disabled" }
  | { phase: "enrolling"; data: TotpEnableResponse };

export default function MasterTotpPage() {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Confirm step
  const [confirmCode, setConfirmCode] = useState("");
  // Disable step
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  // Recovery codes — shown ONCE after generation. Regenerating wipes prior set.
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [generatingCodes, setGeneratingCodes] = useState(false);

  const generateCodes = async () => {
    if (
      !confirm(
        "Generate fresh recovery codes? This invalidates any previously-issued codes.",
      )
    ) {
      return;
    }
    setGeneratingCodes(true);
    setError("");
    try {
      const r = await api.generateRecoveryCodes();
      setRecoveryCodes(r.codes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGeneratingCodes(false);
    }
  };

  // We don't have a "get my totp status" endpoint, so we infer from enable's
  // 409 response: if 2FA is already enabled, /enable returns 409 and we can
  // skip to the disable form.
  useEffect(() => {
    setState({ phase: "disabled" });
  }, []);

  const startEnroll = async () => {
    setError("");
    setBusy(true);
    try {
      const data = await api.totpEnable();
      setState({ phase: "enrolling", data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      if (msg.toLowerCase().includes("already enabled")) {
        setState({ phase: "enabled" });
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    setError("");
    setBusy(true);
    try {
      await api.totpConfirm(confirmCode);
      setState({ phase: "enabled" });
      setConfirmCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setError("");
    setBusy(true);
    try {
      await api.totpDisable(disablePassword, disableCode);
      setState({ phase: "disabled" });
      setDisablePassword("");
      setDisableCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">
          Two-factor authentication
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Adds a 6-digit time-based code from your authenticator app on top of
          your password. Strongly recommended for the master dashboard since
          it controls every tenant.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          {error}
        </div>
      )}

      {state.phase === "loading" && (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}

      {state.phase === "disabled" && (
        <div className="rounded-xl border border-border bg-bg-surface p-6">
          <p className="mb-4 text-sm text-text-muted">
            2FA is currently <strong className="text-error">off</strong> for
            this account.
          </p>
          <button
            onClick={startEnroll}
            disabled={busy}
            className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? "Generating…" : "Enable 2FA"}
          </button>
          <p className="mt-3 text-xs text-text-muted/70">
            If 2FA is already on for this account, click anyway — you&rsquo;ll
            be redirected to the disable flow.
          </p>
        </div>
      )}

      {state.phase === "enrolling" && (
        <div className="rounded-xl border border-amber-500/40 bg-bg-surface p-6">
          <h2 className="mb-3 font-semibold text-text-primary">
            Step 1 — Add to your authenticator
          </h2>
          <p className="mb-3 text-sm text-text-muted">
            Scan this URI as a QR (or copy-paste it) into Google Authenticator,
            Authy, 1Password, etc.
          </p>
          <code className="mb-4 block break-all rounded-lg border border-border bg-bg-primary p-3 font-mono text-xs text-text-primary">
            {state.data.provisioning_uri}
          </code>
          <p className="mb-4 text-xs text-text-muted">
            Or type the secret manually:{" "}
            <code className="font-mono text-text-primary">
              {state.data.secret}
            </code>
          </p>

          <h2 className="mb-3 font-semibold text-text-primary">
            Step 2 — Confirm with a code
          </h2>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            placeholder="123456"
            value={confirmCode}
            onChange={(e) =>
              setConfirmCode(e.target.value.replace(/\D/g, "").slice(0, 6))
            }
            className="mb-4 w-full rounded-lg border border-primary/30 bg-bg-primary px-4 py-2.5 text-center font-mono text-lg tracking-widest text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={handleConfirm}
            disabled={busy || confirmCode.length !== 6}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? "Confirming…" : "Confirm and enable"}
          </button>
        </div>
      )}

      {state.phase === "enabled" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-success/40 bg-bg-surface p-6">
            <p className="text-sm text-text-muted">
              2FA is currently <strong className="text-success">on</strong> for
              this account. Future logins will require a code from your
              authenticator app.
            </p>
          </div>

          {/* Recovery codes */}
          <div className="rounded-xl border border-warning/40 bg-bg-surface p-6">
            <h2 className="mb-2 font-semibold text-text-primary">
              Recovery codes
            </h2>
            <p className="mb-3 text-xs text-text-muted">
              Single-use codes that work when you don&rsquo;t have your
              authenticator. Generate, save them somewhere safe (password
              manager + paper backup), then file them away. Each code works
              exactly once at the login screen in place of the 6-digit code.
            </p>
            {recoveryCodes ? (
              <>
                <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg border border-border bg-bg-primary p-3 font-mono text-sm text-text-primary">
                  {recoveryCodes.map((c, i) => (
                    <div key={i} className="select-all">
                      {c}
                    </div>
                  ))}
                </div>
                <p className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                  ⚠ These codes are shown ONCE. They&rsquo;re not retrievable
                  later. Save them now.
                </p>
                <button
                  onClick={() => setRecoveryCodes(null)}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:bg-bg-surface-hover"
                >
                  I&rsquo;ve saved them — hide
                </button>
              </>
            ) : (
              <button
                onClick={generateCodes}
                disabled={generatingCodes}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {generatingCodes ? "Generating…" : "Generate 10 recovery codes"}
              </button>
            )}
          </div>

          <div className="rounded-xl border border-error/40 bg-bg-surface p-6">
          <h2 className="mb-3 font-semibold text-text-primary">Disable 2FA</h2>
          <p className="mb-3 text-xs text-text-muted">
            Re-enter your password and a current code to confirm. Don&rsquo;t
            disable 2FA unless you know what you&rsquo;re doing — the master
            dashboard is high-impact.
          </p>

          <input
            type="password"
            placeholder="Current password"
            value={disablePassword}
            onChange={(e) => setDisablePassword(e.target.value)}
            className="mb-3 w-full rounded-lg border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary outline-none focus:border-error focus:ring-1 focus:ring-error"
          />
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            placeholder="6-digit code"
            value={disableCode}
            onChange={(e) =>
              setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))
            }
            className="mb-4 w-full rounded-lg border border-border bg-bg-primary px-4 py-2.5 text-center font-mono text-lg tracking-widest text-text-primary outline-none focus:border-error focus:ring-1 focus:ring-error"
          />
          <button
            onClick={handleDisable}
            disabled={busy || !disablePassword || disableCode.length !== 6}
            className="rounded-lg border border-error/40 bg-error/10 px-4 py-2.5 text-sm font-semibold text-error hover:bg-error/20 disabled:opacity-50"
          >
            {busy ? "Disabling…" : "Disable 2FA"}
          </button>
          </div>
        </div>
      )}
    </div>
  );
}
