import { useEffect, useState } from "react";
import { tauri } from "@/lib/tauri";
import { apiGet, apiPatch } from "@/lib/rest";
import { useAppStore } from "@/store/appStore";

type Tab = "general" | "branding" | "flags";

interface Branding {
  logo_url: string | null;
  primary_color: string | null;
  support_email: string | null;
  custom_welcome_message: string | null;
}

interface FeatureFlags {
  effective: Record<string, unknown>;
  overrides: Record<string, unknown>;
  defaults: Record<string, unknown>;
}

export default function SettingsPage() {
  const { status, refresh } = useAppStore();
  const [tab, setTab] = useState<Tab>("general");

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-2xl font-bold">Settings</h1>

      <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1">
        {(["general", "branding", "flags"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
              tab === t
                ? "bg-primary text-white"
                : "text-slate-400 hover:bg-slate-800"
            }`}
          >
            {t === "general"
              ? "General"
              : t === "branding"
              ? "Branding"
              : "Feature flags"}
          </button>
        ))}
      </div>

      {tab === "general" && status && (
        <GeneralTab status={status} refresh={refresh} />
      )}
      {tab === "branding" && <BrandingTab />}
      {tab === "flags" && <FlagsTab />}
    </div>
  );
}

// ─── General: output dir, concurrency, danger zone ──────────────────────────

function GeneralTab({
  status,
  refresh,
}: {
  status: { output_dir: string; max_concurrent_jobs: number };
  refresh: () => Promise<void>;
}) {
  const [outputDir, setOutputDir] = useState(status.output_dir);
  const [maxJobs, setMaxJobs] = useState(status.max_concurrent_jobs);
  const [saving, setSaving] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const handlePickDir = async () => {
    const dir = await tauri.pickFolder();
    if (dir) setOutputDir(dir);
  };

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await tauri.setSettings({
        output_dir: outputDir,
        max_concurrent_jobs: maxJobs,
      });
      await refresh();
      setMsg("Saved.");
    } catch (err) {
      setMsg(typeof err === "string" ? err : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleForgetMasterKey = async () => {
    if (
      !confirm(
        "Forget the master key on this device? You'll need to re-register before encrypting again.",
      )
    ) {
      return;
    }
    setForgetting(true);
    try {
      await tauri.forgetMasterKey();
      await refresh();
    } finally {
      setForgetting(false);
    }
  };

  return (
    <>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="mb-2 text-sm font-semibold">Output directory</h2>
        <p className="mb-3 text-xs text-slate-500">
          Where finished <code>.svf</code> files are written. Distribute these
          via Drive, pendrive, email — your choice. URLs are optional.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={outputDir}
            onChange={(e) => setOutputDir(e.target.value)}
            className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          />
          <button
            onClick={handlePickDir}
            className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700"
          >
            Browse…
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="mb-2 text-sm font-semibold">Concurrency</h2>
        <p className="mb-3 text-xs text-slate-500">
          How many videos to encrypt at once. Disk I/O is usually the
          bottleneck, so 1 is fine for most machines; raise this only if your
          disk is unusually fast.
        </p>
        <input
          type="number"
          min={1}
          max={8}
          value={maxJobs}
          onChange={(e) => setMaxJobs(parseInt(e.target.value, 10) || 1)}
          className="w-24 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
        />
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-primary px-4 py-2 font-medium text-white hover:bg-primary-dark disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
        {msg && <span className="text-sm text-slate-400">{msg}</span>}
      </div>

      <section className="rounded-2xl border border-red-900 bg-red-950/40 p-5">
        <h2 className="mb-1 text-sm font-semibold text-red-300">Danger zone</h2>
        <p className="mb-3 text-xs text-red-200">
          Forget the master key on this device. You&rsquo;ll need your offline
          backup or a fresh re-registration to encrypt again.
        </p>
        <button
          onClick={handleForgetMasterKey}
          disabled={forgetting}
          className="rounded-md border border-red-700 bg-red-900 px-3 py-2 text-sm font-medium text-red-100 hover:bg-red-800 disabled:opacity-50"
        >
          {forgetting ? "Forgetting…" : "Forget master key"}
        </button>
      </section>
    </>
  );
}

// ─── Branding ────────────────────────────────────────────────────────────────

function BrandingTab() {
  const [b, setB] = useState<Branding | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    apiGet<Branding>("/api/admin/tenant/branding")
      .then(setB)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, []);

  if (error) {
    return <ErrorBanner text={error} />;
  }
  if (!b) return <Spinner />;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const next = await apiPatch<Branding>("/api/admin/tenant/branding", b);
      setB(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={save}
      className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5"
    >
      <BField
        label="Logo URL"
        help="Hosted on your Drive or any public HTTPS host. Shown in the player splash."
        value={b.logo_url ?? ""}
        onChange={(v) => setB({ ...b, logo_url: v || null })}
        placeholder="https://drive.google.com/…"
      />
      <BField
        label="Primary color"
        help="Hex code (#1f2937) or any CSS color. Tints player + login screens."
        value={b.primary_color ?? ""}
        onChange={(v) => setB({ ...b, primary_color: v || null })}
        placeholder="#6366f1"
      />
      <BField
        label="Support email"
        help="Shown to students if they hit an error in the player."
        value={b.support_email ?? ""}
        onChange={(v) => setB({ ...b, support_email: v || null })}
        placeholder="support@yourinstitute.com"
      />
      <BField
        label="Welcome message"
        help="Optional banner shown on first login."
        value={b.custom_welcome_message ?? ""}
        onChange={(v) => setB({ ...b, custom_welcome_message: v || null })}
        multiline
      />

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save branding"}
      </button>
      {saved && <span className="ml-3 text-sm text-emerald-400">Saved.</span>}
    </form>
  );
}

function BField({
  label,
  help,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  label: string;
  help?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm text-slate-400">{label}</label>
      {multiline ? (
        <textarea
          rows={3}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
        />
      )}
      {help && <p className="mt-1 text-xs text-slate-500">{help}</p>}
    </div>
  );
}

// ─── Feature flags ───────────────────────────────────────────────────────────

function FlagsTab() {
  const [flags, setFlags] = useState<FeatureFlags | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet<FeatureFlags>("/api/admin/tenant/feature-flags")
      .then(setFlags)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, []);

  const save = async (key: string, value: unknown) => {
    if (!flags) return;
    setSaving(true);
    setError("");
    try {
      const next = await apiPatch<FeatureFlags>(
        "/api/admin/tenant/feature-flags",
        { flags: { [key]: value } },
      );
      setFlags(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (error) return <ErrorBanner text={error} />;
  if (!flags) return <Spinner />;

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <p className="mb-3 text-xs text-slate-500">
        Effective values shown — defaults until you override.
      </p>
      {Object.entries(flags.defaults).map(([key, defVal]) => {
        const cur = (flags.effective as Record<string, unknown>)[key] ?? defVal;
        return (
          <FlagRow
            key={key}
            name={key}
            value={cur}
            isOverridden={key in (flags.overrides as Record<string, unknown>)}
            disabled={saving}
            onChange={(v) => save(key, v)}
          />
        );
      })}
    </div>
  );
}

function FlagRow({
  name,
  value,
  isOverridden,
  disabled,
  onChange,
}: {
  name: string;
  value: unknown;
  isOverridden: boolean;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  const [edit, setEdit] = useState<string>(JSON.stringify(value));

  const commit = () => {
    try {
      onChange(JSON.parse(edit));
    } catch {
      onChange(edit);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-800 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-sm">{name}</p>
        {isOverridden && (
          <p className="text-xs text-amber-400">overridden from default</p>
        )}
      </div>
      <input
        value={edit}
        onChange={(e) => setEdit(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        disabled={disabled}
        className="w-48 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-right font-mono text-xs"
      />
    </div>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex items-center justify-center py-10">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

function ErrorBanner({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
      {text}
    </p>
  );
}
