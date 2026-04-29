// Two-tier storage:
//   - secure (tokens, license-key bundle) → react-native-keychain (OS keychain)
//   - fast non-secret (course list cache, last-played video, settings) → MMKV
//
// Both are sync-friendly except the keychain reads which are inherently async.

import { MMKV } from "react-native-mmkv";
import * as Keychain from "react-native-keychain";

const KEYCHAIN_SERVICE = "com.svp.player";

export const cache = new MMKV({ id: "svp-player-cache" });

export interface SecureTokens {
  accessToken: string;
  refreshToken: string;
}

const KEYCHAIN_USER_TOKENS = "tokens";

export async function saveTokens(t: SecureTokens): Promise<void> {
  await Keychain.setInternetCredentials(
    KEYCHAIN_SERVICE,
    KEYCHAIN_USER_TOKENS,
    JSON.stringify(t),
  );
}

export async function loadTokens(): Promise<SecureTokens | null> {
  const creds = await Keychain.getInternetCredentials(KEYCHAIN_SERVICE);
  // react-native-keychain v9 returns the credentials object on success and
  // `false` on "no entry" — TS sees them as the same overload, so we
  // narrow with a runtime truthy check.
  if (!creds) return null;
  try {
    return JSON.parse(creds.password) as SecureTokens;
  } catch {
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  await Keychain.resetInternetCredentials({ server: KEYCHAIN_SERVICE });
}
