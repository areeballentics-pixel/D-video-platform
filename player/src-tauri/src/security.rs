// security.rs — Anti-piracy protections
//
// Implements multiple layers of protection during video playback:
// 1. Screen capture prevention (SetWindowDisplayAffinity on Windows)
// 2. Screen recorder process scanning
// 3. Remote desktop / screen sharing detection
// 4. Virtual machine detection
// 5. Debugger detection
//
// All detections are non-destructive: warn + pause + log, never kill processes.

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::watch;

/// Types of security violations that can be detected
#[derive(Debug, Clone, Serialize)]
pub enum SecurityViolation {
    ScreenRecorderDetected { process_name: String },
    RemoteDesktopActive,
    VirtualMachineDetected { vm_type: String },
    DebuggerAttached,
}

/// Result of a security check
#[derive(Debug, Clone, Serialize)]
pub struct SecurityStatus {
    pub is_safe: bool,
    pub violations: Vec<SecurityViolation>,
}

/// Known screen recording software process names
const SCREEN_RECORDER_PROCESSES: &[&str] = &[
    "obs64.exe",
    "obs32.exe",
    "obs.exe",
    "CamtasiaStudio.exe",
    "CamRecorder.exe",
    "Bandicam.exe",
    "bdcam.exe",
    "ShareX.exe",
    "XSplit.Core.exe",
    "XSplitBroadcaster.exe",
    "Action.exe",          // Mirillis Action
    "GameBar.exe",
    "GameBarPresenceWriter.exe",
    "ScreenClippingHost.exe",
    "SnippingTool.exe",
    "ffmpeg.exe",          // Could be used for capture
    "Streamlabs OBS.exe",
    "ScreenFlow.exe",
    "SimpleScreenRecorder",
    "kazam",
];

/// Known remote desktop / screen sharing process names
const REMOTE_DESKTOP_PROCESSES: &[&str] = &[
    "TeamViewer.exe",
    "TeamViewer_Service.exe",
    "anydesk.exe",
    "AnyDesk.exe",
    "parsec.exe",
    "parsecfw.exe",
    "mstsc.exe",           // Microsoft Remote Desktop
    "rustdesk.exe",
    "chrome_remote_desktop_host.exe",
];

// ─── Screen Capture Protection ───

/// Enable screen capture protection on the main window.
///
/// Uses SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) on Windows 10 1903+.
/// After calling this, the window appears completely BLACK in all screen capture
/// tools (OBS, PrintScreen, Snipping Tool, ShareX, Discord, Zoom, etc.)
/// but remains visible on the physical display.
#[cfg(windows)]
pub fn enable_capture_protection(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WINDOW_DISPLAY_AFFINITY,
    };
    use windows::Win32::Foundation::HWND;

    let hwnd = window.hwnd().map_err(|e| format!("Cannot get HWND: {}", e))?;
    let hwnd = HWND(hwnd.0);

    unsafe {
        // WDA_EXCLUDEFROMCAPTURE = 0x11 — makes window black in all capture tools
        SetWindowDisplayAffinity(hwnd, WINDOW_DISPLAY_AFFINITY(0x00000011))
            .map_err(|e| format!("SetWindowDisplayAffinity failed: {}", e))?;
    }

    log::info!("Screen capture protection enabled (WDA_EXCLUDEFROMCAPTURE)");
    Ok(())
}

#[cfg(not(windows))]
pub fn enable_capture_protection(_window: &tauri::WebviewWindow) -> Result<(), String> {
    log::warn!("Screen capture protection not available on this platform");
    Ok(())
}

/// Disable screen capture protection (restore normal behavior).
#[cfg(windows)]
pub fn disable_capture_protection(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WINDOW_DISPLAY_AFFINITY,
    };
    use windows::Win32::Foundation::HWND;

    let hwnd = window.hwnd().map_err(|e| format!("Cannot get HWND: {}", e))?;
    let hwnd = HWND(hwnd.0);

    unsafe {
        SetWindowDisplayAffinity(hwnd, WINDOW_DISPLAY_AFFINITY(0x00000000))
            .map_err(|e| format!("Failed to disable capture protection: {}", e))?;
    }

    log::info!("Screen capture protection disabled");
    Ok(())
}

#[cfg(not(windows))]
pub fn disable_capture_protection(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

// ─── Process Scanning ───

/// Scan running processes for known screen recording software.
#[cfg(windows)]
pub fn scan_screen_recorders() -> Vec<String> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW,
        PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    let mut found = Vec::new();

    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return found,
        };

        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let name = String::from_utf16_lossy(
                    &entry.szExeFile[..entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len())]
                );

                let name_lower = name.to_lowercase();
                for &recorder in SCREEN_RECORDER_PROCESSES {
                    if name_lower == recorder.to_lowercase() {
                        found.push(name.clone());
                    }
                }

                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }

        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
    }

    found
}

#[cfg(not(windows))]
pub fn scan_screen_recorders() -> Vec<String> {
    Vec::new()
}

/// Scan for remote desktop / screen sharing software.
#[cfg(windows)]
pub fn scan_remote_desktop() -> Vec<String> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW,
        PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    let mut found = Vec::new();

    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return found,
        };

        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let name = String::from_utf16_lossy(
                    &entry.szExeFile[..entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len())]
                );

                let name_lower = name.to_lowercase();
                for &rdp in REMOTE_DESKTOP_PROCESSES {
                    if name_lower == rdp.to_lowercase() {
                        found.push(name.clone());
                    }
                }

                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }

        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
    }

    found
}

#[cfg(not(windows))]
pub fn scan_remote_desktop() -> Vec<String> {
    Vec::new()
}

// ─── Remote Desktop Session Detection ───

/// Check if we're running inside an RDP (Remote Desktop) session.
#[cfg(windows)]
pub fn is_remote_session() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics;
    use windows::Win32::UI::WindowsAndMessaging::SM_REMOTESESSION;

    unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
}

#[cfg(not(windows))]
pub fn is_remote_session() -> bool {
    false
}

// ─── Virtual Machine Detection ───

/// Check if running inside a virtual machine.
#[cfg(windows)]
pub fn detect_virtual_machine() -> Option<String> {
    use wmi::WMIConnection;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Win32ComputerSystem {
        manufacturer: Option<String>,
        model: Option<String>,
    }

    let wmi_con = match WMIConnection::new() {
        Ok(c) => c,
        Err(_) => return None,
    };

    let results: Vec<Win32ComputerSystem> = wmi_con
        .raw_query("SELECT Manufacturer, Model FROM Win32_ComputerSystem")
        .unwrap_or_default();

    if let Some(cs) = results.first() {
        let manufacturer = cs.manufacturer.as_deref().unwrap_or("").to_lowercase();
        let model = cs.model.as_deref().unwrap_or("").to_lowercase();

        let combined = format!("{} {}", manufacturer, model);

        if combined.contains("vmware") {
            return Some("VMware".to_string());
        }
        if combined.contains("virtualbox") || combined.contains("vbox") {
            return Some("VirtualBox".to_string());
        }
        if combined.contains("hyper-v") || combined.contains("virtual machine") {
            return Some("Hyper-V".to_string());
        }
        if combined.contains("qemu") {
            return Some("QEMU".to_string());
        }
        if combined.contains("parallels") {
            return Some("Parallels".to_string());
        }
        if combined.contains("xen") {
            return Some("Xen".to_string());
        }
    }

    None
}

#[cfg(not(windows))]
pub fn detect_virtual_machine() -> Option<String> {
    None
}

// ─── Debugger Detection ───

/// Check if a debugger is attached to the process.
#[cfg(windows)]
pub fn is_debugger_attached() -> bool {
    use windows::Win32::System::Diagnostics::Debug::IsDebuggerPresent;

    unsafe {
        // IsDebuggerPresent is the most reliable single check.
        // CheckRemoteDebuggerPresent requires BOOL type handling that varies
        // across windows crate versions, so we skip it for now.
        IsDebuggerPresent().as_bool()
    }
}

#[cfg(not(windows))]
pub fn is_debugger_attached() -> bool {
    false
}

// ─── Comprehensive Security Check ───

/// Run all security checks and return the combined result.
pub fn check_security() -> SecurityStatus {
    let mut violations = Vec::new();

    // 1. Screen recorders
    for proc in scan_screen_recorders() {
        violations.push(SecurityViolation::ScreenRecorderDetected {
            process_name: proc,
        });
    }

    // 2. Remote desktop
    if is_remote_session() {
        violations.push(SecurityViolation::RemoteDesktopActive);
    }
    for proc in scan_remote_desktop() {
        // Only add if not already covered by RDP session check
        if !matches!(violations.last(), Some(SecurityViolation::RemoteDesktopActive)) {
            violations.push(SecurityViolation::ScreenRecorderDetected {
                process_name: proc,
            });
        }
    }

    // 3. VM detection
    if let Some(vm_type) = detect_virtual_machine() {
        violations.push(SecurityViolation::VirtualMachineDetected { vm_type });
    }

    // 4. Debugger
    if is_debugger_attached() {
        violations.push(SecurityViolation::DebuggerAttached);
    }

    SecurityStatus {
        is_safe: violations.is_empty(),
        violations,
    }
}

// ─── Background Security Monitor ───

/// A background task that periodically runs security checks during playback.
/// Emits Tauri events when violations are detected.
pub struct SecurityMonitor {
    stop_tx: watch::Sender<bool>,
}

impl SecurityMonitor {
    /// Start the security monitor. Runs checks every 30 seconds.
    /// Emits "security-violation" events to the frontend when threats are detected.
    pub fn start(app_handle: tauri::AppHandle) -> Self {
        let (stop_tx, mut stop_rx) = watch::channel(false);

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));

            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        let status = check_security();
                        if !status.is_safe {
                            log::warn!("Security violations detected: {:?}", status.violations);
                            let _ = app_handle.emit("security-violation", &status);
                        }
                    }
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            log::info!("Security monitor stopped");
                            break;
                        }
                    }
                }
            }
        });

        log::info!("Security monitor started (checking every 30s)");
        SecurityMonitor { stop_tx }
    }

    /// Stop the security monitor.
    pub fn stop(&self) {
        let _ = self.stop_tx.send(true);
    }
}

impl Drop for SecurityMonitor {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_security_runs() {
        // Just verify it doesn't crash
        let status = check_security();
        println!("Security status: is_safe={}, violations={}", status.is_safe, status.violations.len());
        for v in &status.violations {
            println!("  {:?}", v);
        }
    }
}
