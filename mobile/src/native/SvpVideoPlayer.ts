// SvpVideoPlayer — TypeScript spec for the native video module.
//
// Tasks #9 (Android Kotlin) and #10 (iOS Swift) implement this interface:
//   - Android: app/src/main/kotlin/com/svp/player/SvpVideoPlayerModule.kt
//   - iOS:     ios/SvpVideoPlayer/SvpVideoPlayerModule.swift
//
// The same JS code calls SvpVideoPlayer.play() on both platforms; the native
// modules do platform-specific work:
//   - Wrap ExoPlayer / AVPlayer
//   - Install a custom byte-range DataSource that decrypts .svf chunks on
//     demand via JNI/FFI to svf-core
//   - Set FLAG_SECURE / observe UIScreen.isCaptured
//   - Render onto the view passed in via mountSurface()
//
// Returns "module not installed" on platforms where the native side hasn't
// been built — useful while the JS scaffolding exists but native modules
// haven't been wired in yet.

import { NativeModules, NativeEventEmitter, Platform } from "react-native";

export interface PlayParams {
  /** Local path to the .svf file. */
  svfPath: string;
  /** Hex-encoded 32-byte AES key for this (video, quality). */
  keyHex: string;
  /** Quality int from the .svf header (0=480p, 1=720p, 2=1080p, 65535=original). */
  quality: number;
  /** Whether to apply FLAG_SECURE / iOS equivalent. Defaults to true. */
  secureSurface?: boolean;
}

export interface PlaybackEvent {
  type:
    | "ready"
    | "playing"
    | "paused"
    | "ended"
    | "error"
    | "position"
    | "screen-recording-started"
    | "screen-recording-stopped"
    | "tamper";
  position_ms?: number;
  duration_ms?: number;
  message?: string;
}

interface NativeSpec {
  /** Returns true once the .so / xcframework is loaded and JNI bridge is ready. */
  isReady(): Promise<boolean>;

  /** Begin playback. Resolves with the resolved duration in ms once ExoPlayer/AVPlayer is prepared. */
  play(params: PlayParams): Promise<{ duration_ms: number }>;

  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  stop(): Promise<void>;

  /** Current playback position in milliseconds. */
  getPosition(): Promise<number>;

  /** Run anti-piracy heuristics (root/jailbreak, debugger, emulator). */
  runSecurityChecks(): Promise<{
    safe: boolean;
    violations: string[];
  }>;
}

const isStub = !NativeModules.SvpVideoPlayer;

/** Throws a helpful error pointing at the right task to implement. */
function stubError(method: string): never {
  throw new Error(
    `Native module SvpVideoPlayer.${method} is not yet installed. ` +
      `Build the ${
        Platform.OS === "ios" ? "iOS Swift" : "Android Kotlin"
      } module (see README + Tasks #9 / #10) and rebuild the app.`,
  );
}

const stub: NativeSpec = {
  isReady: async () => false,
  play: async () => stubError("play"),
  pause: async () => stubError("pause"),
  resume: async () => stubError("resume"),
  seek: async () => stubError("seek"),
  stop: async () => stubError("stop"),
  getPosition: async () => stubError("getPosition"),
  runSecurityChecks: async () => ({
    safe: true,
    violations: ["native-module-missing"],
  }),
};

export const SvpVideoPlayer: NativeSpec = isStub
  ? stub
  : (NativeModules.SvpVideoPlayer as NativeSpec);

export const SvpVideoPlayerEvents = isStub
  ? null
  : new NativeEventEmitter(NativeModules.SvpVideoPlayer);

export const isNativeModuleInstalled = !isStub;
