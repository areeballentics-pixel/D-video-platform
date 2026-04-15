import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

interface SecurityStatus {
  is_safe: boolean;
  violations: Array<{
    ScreenRecorderDetected?: { process_name: string };
    RemoteDesktopActive?: null;
    VirtualMachineDetected?: { vm_type: string };
    DebuggerAttached?: null;
  }>;
}

/**
 * Security warning banner that appears when a threat is detected.
 * Shows a dismissible warning and optionally pauses the video.
 */
export default function SecurityWarning({
  onPause,
}: {
  onPause?: () => void;
}) {
  const [warning, setWarning] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const unlisten = listen<SecurityStatus>("security-violation", (event) => {
      const status = event.payload;
      if (!status.is_safe && status.violations.length > 0) {
        // Build a human-readable warning message
        const messages: string[] = [];
        for (const v of status.violations) {
          if ("ScreenRecorderDetected" in v && v.ScreenRecorderDetected) {
            messages.push(
              `Screen recording software detected: ${v.ScreenRecorderDetected.process_name}`
            );
          }
          if ("RemoteDesktopActive" in v) {
            messages.push("Remote desktop session detected");
          }
          if ("VirtualMachineDetected" in v && v.VirtualMachineDetected) {
            messages.push(
              `Virtual machine detected: ${v.VirtualMachineDetected.vm_type}`
            );
          }
          if ("DebuggerAttached" in v) {
            messages.push("Debugger detected");
          }
        }

        setWarning(messages.join(". ") + ".");
        setVisible(true);
        onPause?.();
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [onPause]);

  if (!visible || !warning) return null;

  return (
    <div className="absolute inset-x-0 top-12 z-50 flex justify-center px-4">
      <div className="flex items-center gap-3 rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-5 py-3 backdrop-blur-sm max-w-2xl">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="shrink-0 text-[var(--color-error)]"
        >
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <p className="text-sm text-[var(--color-error)]">{warning}</p>
        <button
          onClick={() => setVisible(false)}
          className="shrink-0 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
