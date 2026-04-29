import { Link, useLocation } from "react-router-dom";
import { tauri } from "@/lib/tauri";
import { useAppStore } from "@/store/appStore";

const items = [
  { to: "/jobs", label: "Jobs" },
  { to: "/courses", label: "Courses" },
  { to: "/students", label: "Students" },
  { to: "/awaiting-upload", label: "Distribution" },
  { to: "/encryptors", label: "Encryptors" },
  { to: "/analytics", label: "Analytics" },
  { to: "/audit", label: "Audit log" },
  { to: "/settings", label: "Settings" },
];

export default function Sidebar() {
  const { status, refresh } = useAppStore();
  const location = useLocation();

  const handleLogout = async () => {
    await tauri.logout();
    await refresh();
  };

  return (
    <aside className="flex w-64 flex-col border-r border-slate-800 bg-slate-900">
      <div className="border-b border-slate-800 px-5 py-5">
        <h1 className="text-lg font-bold text-white">SVP Encryptor</h1>
        <p className="text-xs text-slate-400">v0.1.0 · institute-side</p>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {items.map((item) => {
          const active = location.pathname === item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={`flex items-center justify-between rounded-md px-3 py-2 text-sm transition ${
                active
                  ? "bg-primary text-white"
                  : "text-slate-300 hover:bg-slate-800"
              }`}
            >
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Footer: identity only — server URL deliberately hidden from UI to
          avoid surfacing infra details to end-users. Power users can still
          override it by editing %APPDATA%/com.svp.encryptor/config.json. */}
      <div className="border-t border-slate-800 p-4 text-xs text-slate-400">
        <p className="truncate text-slate-300">{status?.last_admin_email}</p>
        {status?.tenant_name && (
          <p className="truncate">{status.tenant_name}</p>
        )}
        <button
          onClick={handleLogout}
          className="mt-3 w-full rounded-md border border-slate-700 px-3 py-1.5 text-slate-300 hover:bg-slate-800"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
