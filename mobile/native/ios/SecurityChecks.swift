import Foundation
import UIKit

/// Anti-piracy heuristics for iOS. Counterpart to the Android `SecurityChecks`.
///
/// iOS 13+ has no API to block screen recording outright (Android's
/// `FLAG_SECURE` has no equivalent). The strongest mitigations available:
///   - `UIScreen.main.isCaptured` observer to pause playback when a
///     recording starts. The user can re-start it but the moment is logged.
///   - Jailbreak detection refuses to play on compromised devices.
///   - The watermark overlay (rendered on the RN side) means any leaked
///     recording still carries the student's identifier.

@objc final class SecurityChecks: NSObject {

    @objc static func runAll() -> [String: Any] {
        var violations: [String] = []
        if isJailbroken() { violations.append("device-jailbroken") }
        if isDebuggerAttached() { violations.append("debugger-attached") }
        if UIScreen.main.isCaptured { violations.append("screen-being-captured") }
        return [
            "safe": violations.isEmpty,
            "violations": violations,
        ]
    }

    /// Common jailbreak indicators. None alone is conclusive; the combination
    /// is.
    static func isJailbroken() -> Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        let suspiciousPaths = [
            "/Applications/Cydia.app",
            "/Applications/Sileo.app",
            "/Applications/Zebra.app",
            "/Library/MobileSubstrate/MobileSubstrate.dylib",
            "/bin/bash",
            "/usr/sbin/sshd",
            "/etc/apt",
            "/private/var/lib/apt/",
            "/usr/libexec/cydia",
            "/var/lib/cydia",
        ]
        for p in suspiciousPaths {
            if FileManager.default.fileExists(atPath: p) {
                return true
            }
        }

        // Sandbox escape: if we can write outside the app sandbox, we're
        // running on a jailbroken device with sandbox restrictions removed.
        let probePath = "/private/jb-probe-\(UUID().uuidString)"
        do {
            try "x".write(toFile: probePath, atomically: true, encoding: .utf8)
            try? FileManager.default.removeItem(atPath: probePath)
            return true
        } catch {
            // Expected: sandbox blocks the write on a non-jailbroken device.
        }

        // URL scheme check — Cydia registers `cydia://`.
        if let url = URL(string: "cydia://package/com.example.package"),
           UIApplication.shared.canOpenURL(url) {
            return true
        }

        return false
        #endif
    }

    static func isDebuggerAttached() -> Bool {
        // Standard sysctl-based check; resilient against a few common
        // anti-anti-debug bypasses but not all.
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        let result = sysctl(&mib, u_int(mib.count), &info, &size, nil, 0)
        if result != 0 { return false }
        return (info.kp_proc.p_flag & P_TRACED) != 0
    }
}
