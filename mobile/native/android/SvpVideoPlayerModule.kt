package com.svp.player

import android.view.WindowManager
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * React Native bridge for the SVF player on Android. Implements the
 * `SvpVideoPlayer` TS interface from mobile/src/native/SvpVideoPlayer.ts.
 *
 * Lifecycle is intentionally simple: at most one active ExoPlayer instance
 * per RN context. Calling `play()` while one is running stops the previous
 * one. The View hierarchy that hosts the player surface is provided by RN
 * via a separate ViewManager (not in this v1 minimal stub — added in v1.1
 * once we have a custom React component <SvpPlayerView />).
 */
class SvpVideoPlayerModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    private var player: ExoPlayer? = null

    override fun getName(): String = "SvpVideoPlayer"

    @ReactMethod
    fun isReady(promise: Promise) {
        // The native side is "ready" as long as the .so loaded successfully.
        // RustBindings is `object`, so its init { System.loadLibrary } already
        // ran on first reference; if it failed we'd have UnsatisfiedLinkError.
        promise.resolve(true)
    }

    @ReactMethod
    fun play(params: ReadableMap, promise: Promise) {
        val svfPath = params.getString("svfPath")
        val keyHex = params.getString("keyHex")
        if (svfPath.isNullOrEmpty() || keyHex.isNullOrEmpty()) {
            promise.reject("invalid_params", "svfPath and keyHex are required")
            return
        }
        val secureSurface = params.takeIf { it.hasKey("secureSurface") }?.getBoolean("secureSurface") ?: true

        // Apply FLAG_SECURE on the host Activity. Done via UI thread.
        currentActivity?.runOnUiThread {
            if (secureSurface) {
                currentActivity?.window?.setFlags(
                    WindowManager.LayoutParams.FLAG_SECURE,
                    WindowManager.LayoutParams.FLAG_SECURE,
                )
            }
        }

        val masterKey = try {
            hexDecode(keyHex)
        } catch (e: IllegalArgumentException) {
            promise.reject("bad_key", "keyHex must be valid hex")
            return
        }

        currentActivity?.runOnUiThread {
            try {
                releasePlayer()
                val factory: DataSource.Factory = SvpDataSource.Factory(svfPath, masterKey)
                val mediaSource = ProgressiveMediaSource.Factory(factory)
                    .createMediaSource(
                        MediaItem.Builder()
                            .setUri("svp://current")
                            .setMimeType(MimeTypes.VIDEO_MP4)
                            .build()
                    )
                val p = ExoPlayer.Builder(reactContext).build()
                p.setMediaSource(mediaSource)
                p.prepare()
                p.playWhenReady = true
                player = p

                // Resolve once prepared. ExoPlayer's onPlaybackStateChanged
                // would be more accurate; this stub returns immediately so
                // the JS side can bind UI listeners while preparation runs.
                val resp = Arguments.createMap()
                resp.putDouble("duration_ms", 0.0)
                promise.resolve(resp)
            } catch (e: Throwable) {
                promise.reject("play_failed", e.message, e)
            }
        }
    }

    @ReactMethod
    fun pause(promise: Promise) {
        currentActivity?.runOnUiThread {
            player?.playWhenReady = false
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun resume(promise: Promise) {
        currentActivity?.runOnUiThread {
            player?.playWhenReady = true
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun seek(positionMs: Double, promise: Promise) {
        currentActivity?.runOnUiThread {
            player?.seekTo(positionMs.toLong())
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        currentActivity?.runOnUiThread {
            releasePlayer()
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun getPosition(promise: Promise) {
        currentActivity?.runOnUiThread {
            promise.resolve((player?.currentPosition ?: 0L).toDouble())
        }
    }

    @ReactMethod
    fun runSecurityChecks(promise: Promise) {
        val (safe, violations) = SecurityChecks.runAll()
        val resp = Arguments.createMap()
        resp.putBoolean("safe", safe)
        val arr = Arguments.createArray()
        for (v in violations) arr.pushString(v)
        resp.putArray("violations", arr)
        promise.resolve(resp)
    }

    private fun releasePlayer() {
        player?.release()
        player = null
    }

    /** Emit a custom event back to JS (used for playback state changes etc). */
    @Suppress("unused")
    private fun emit(name: String, payload: Any?) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(name, payload)
    }

    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        currentActivity?.runOnUiThread { releasePlayer() }
    }

    private fun hexDecode(s: String): ByteArray {
        require(s.length % 2 == 0) { "hex string must have even length" }
        val out = ByteArray(s.length / 2)
        for (i in out.indices) {
            val hi = Character.digit(s[i * 2], 16)
            val lo = Character.digit(s[i * 2 + 1], 16)
            require(hi >= 0 && lo >= 0) { "invalid hex character" }
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }
}
