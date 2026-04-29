import { create } from "zustand";
import { Platform } from "react-native";

import { api } from "@/lib/api";
import { LicensedKey, LoginResponse } from "@/lib/types";
import { cache, clearTokens, loadTokens, saveTokens } from "@/lib/storage";

interface AuthState {
  ready: boolean;          // true once we've checked for cached tokens
  authenticated: boolean;
  email: string | null;
  tenantId: string | null;
  // Bundle of (video_id, quality, key) entries the player can use offline
  // within the grace period. Cached in MMKV between launches.
  licensedKeys: LicensedKey[];

  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Initial hydration on app launch — pulls cached tokens + bundle. */
  initialize: () => Promise<void>;
}

const CACHE_KEY_LICENSED = "licensed_keys_v1";
const CACHE_KEY_USER = "auth_user_v1";

export const useAuthStore = create<AuthState>((set) => ({
  ready: false,
  authenticated: false,
  email: null,
  tenantId: null,
  licensedKeys: [],

  initialize: async () => {
    const tokens = await loadTokens();
    const cachedUser = cache.getString(CACHE_KEY_USER);
    const cachedBundle = cache.getString(CACHE_KEY_LICENSED);

    if (tokens && cachedUser) {
      const user = JSON.parse(cachedUser) as { email: string; tenant_id: string };
      const licensed = cachedBundle
        ? (JSON.parse(cachedBundle) as LicensedKey[])
        : [];
      set({
        ready: true,
        authenticated: true,
        email: user.email,
        tenantId: user.tenant_id,
        licensedKeys: licensed,
      });
      api.setAuth(
        async () => (await loadTokens())?.accessToken ?? null,
        () => refreshTokens(),
      );
    } else {
      set({ ready: true });
    }
  },

  login: async (email, password) => {
    // Stable per-install fingerprint. Mobile ANDROID_ID would be better; for
    // v1 we hash a UUID stored in MMKV.
    let fingerprint = cache.getString("device_fingerprint");
    if (!fingerprint) {
      fingerprint = `mobile-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
      cache.set("device_fingerprint", fingerprint);
    }

    const resp: LoginResponse = await api.login(
      email,
      password,
      fingerprint,
      `${Platform.OS}-device`,
      String(Platform.Version),
    );

    await saveTokens({
      accessToken: resp.access_token,
      refreshToken: resp.refresh_token,
    });

    cache.set(
      CACHE_KEY_USER,
      JSON.stringify({ email: resp.email, tenant_id: resp.tenant_id }),
    );
    if (resp.licensed_video_keys) {
      cache.set(CACHE_KEY_LICENSED, JSON.stringify(resp.licensed_video_keys));
    }

    set({
      authenticated: true,
      email: resp.email,
      tenantId: resp.tenant_id,
      licensedKeys: resp.licensed_video_keys ?? [],
    });

    api.setAuth(
      async () => (await loadTokens())?.accessToken ?? null,
      () => refreshTokens(),
    );
  },

  logout: async () => {
    await api.logout();
    await clearTokens();
    cache.delete(CACHE_KEY_LICENSED);
    cache.delete(CACHE_KEY_USER);
    set({
      authenticated: false,
      email: null,
      tenantId: null,
      licensedKeys: [],
    });
  },
}));

async function refreshTokens(): Promise<boolean> {
  const cur = await loadTokens();
  if (!cur) return false;
  try {
    const fresh = await api.refreshTokens(cur.refreshToken);
    await saveTokens({
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token,
    });
    return true;
  } catch {
    await clearTokens();
    useAuthStore.setState({
      authenticated: false,
      email: null,
      tenantId: null,
      licensedKeys: [],
    });
    return false;
  }
}
