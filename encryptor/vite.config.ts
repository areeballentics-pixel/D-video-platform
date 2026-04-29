import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Tauri 2 expects the dev server on a fixed port matching tauri.conf.json's
// devUrl. Port 1421 is paired with the SVP Encryptor; the player uses 1420.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 1421,
    strictPort: true,
    host: false,
    hmr: { protocol: "ws", host: "localhost", port: 1421 },
  },
  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
  },
});
