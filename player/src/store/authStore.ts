import { create } from "zustand";
import { checkAuth, login, loginWithKey, logout } from "../lib/tauri";

interface AuthState {
  authenticated: boolean;
  email: string | null;
  loading: boolean;
  error: string;

  /** Check if user is already authenticated (from cached tokens) */
  initialize: () => Promise<void>;
  /** Login with email + password */
  login: (email: string, password: string) => Promise<void>;
  /** Login with license key */
  loginWithKey: (key: string) => Promise<void>;
  /** Logout */
  logout: () => Promise<void>;
  /** Clear error message */
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  authenticated: false,
  email: null,
  loading: true,
  error: "",

  initialize: async () => {
    try {
      const status = await checkAuth();
      set({
        authenticated: status.authenticated,
        email: status.email,
        loading: false,
      });
    } catch {
      set({ authenticated: false, email: null, loading: false });
    }
  },

  login: async (email: string, password: string) => {
    set({ loading: true, error: "" });
    try {
      const status = await login(email, password);
      set({
        authenticated: status.authenticated,
        email: status.email,
        loading: false,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  loginWithKey: async (key: string) => {
    set({ loading: true, error: "" });
    try {
      const status = await loginWithKey(key);
      set({
        authenticated: status.authenticated,
        email: status.email,
        loading: false,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  logout: async () => {
    try {
      await logout();
    } finally {
      set({ authenticated: false, email: null, error: "" });
    }
  },

  clearError: () => set({ error: "" }),
}));
