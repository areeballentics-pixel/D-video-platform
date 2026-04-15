/** Typed wrappers around Tauri invoke() calls */

import { invoke } from "@tauri-apps/api/core";
import type { SvfInfo, PlaybackInfo, DeviceInfo } from "./types";

export interface AuthStatus {
  authenticated: boolean;
  email: string | null;
}

export async function checkAuth(): Promise<AuthStatus> {
  return invoke("check_auth");
}

export async function login(email: string, password: string): Promise<AuthStatus> {
  return invoke("login", { email, password });
}

export async function loginWithKey(licenseKey: string): Promise<AuthStatus> {
  return invoke("login_with_key", { licenseKey });
}

export async function logout(): Promise<void> {
  return invoke("logout");
}

export async function scanLibrary(folder: string): Promise<SvfInfo[]> {
  return invoke("scan_library", { folder });
}

export async function startPlayback(videoPath: string): Promise<PlaybackInfo> {
  return invoke("start_playback", { videoPath });
}

export async function stopPlayback(): Promise<void> {
  return invoke("stop_playback");
}

export async function getDeviceInfo(): Promise<DeviceInfo> {
  return invoke("get_device_info");
}

export async function getAppVersion(): Promise<string> {
  return invoke("get_app_version");
}
