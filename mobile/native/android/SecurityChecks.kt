package com.svp.player

import android.os.Build
import java.io.File

/**
 * Quick anti-tamper / anti-piracy heuristics. None of these are bulletproof
 * — a determined attacker can defeat any of them — but together they raise
 * the bar above "anyone with a rooted phone can re-distribute decrypted videos".
 */
object SecurityChecks {

    /** Returns (safe: Boolean, violations: List<String>). */
    fun runAll(): Pair<Boolean, List<String>> {
        val violations = mutableListOf<String>()
        if (isDeviceRooted()) violations += "device-rooted"
        if (isProbablyEmulator()) violations += "emulator-detected"
        if (isDebuggerAttached()) violations += "debugger-attached"
        return Pair(violations.isEmpty(), violations)
    }

    private val ROOT_BINARIES = listOf(
        "/system/app/Superuser.apk",
        "/sbin/su",
        "/system/bin/su",
        "/system/xbin/su",
        "/data/local/xbin/su",
        "/data/local/bin/su",
        "/system/sd/xbin/su",
        "/system/bin/failsafe/su",
        "/data/local/su",
        "/su/bin/su",
        // Magisk paths
        "/sbin/.magisk",
        "/cache/.magisk",
        "/data/adb/magisk",
    )

    fun isDeviceRooted(): Boolean {
        // Path-based check is fast + deterministic.
        for (path in ROOT_BINARIES) {
            if (File(path).exists()) return true
        }
        // build.tags often contains "test-keys" on rooted/custom builds.
        val tags = Build.TAGS
        if (tags != null && tags.contains("test-keys")) return true
        return false
    }

    fun isProbablyEmulator(): Boolean {
        val fp = Build.FINGERPRINT ?: ""
        val model = Build.MODEL ?: ""
        val brand = Build.BRAND ?: ""
        val device = Build.DEVICE ?: ""
        val product = Build.PRODUCT ?: ""
        val hardware = Build.HARDWARE ?: ""

        return fp.startsWith("generic")
            || fp.startsWith("unknown")
            || model.contains("google_sdk")
            || model.lowercase().contains("emulator")
            || model.contains("Android SDK built for x86")
            || brand.startsWith("generic") && device.startsWith("generic")
            || product == "google_sdk" || product == "sdk_gphone"
            || hardware == "goldfish" || hardware == "ranchu"
    }

    fun isDebuggerAttached(): Boolean {
        return android.os.Debug.isDebuggerConnected() || android.os.Debug.waitingForDebugger()
    }
}
