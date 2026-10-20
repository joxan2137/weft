import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/.ref/**", "**/.research/**", "**/concepts/**"] },
  },
  // The Tauri CLI sets TAURI_ENV_DEBUG for debug builds; a release ships no sourcemaps inside weft.exe.
  build: { target: "chrome120", sourcemap: process.env.TAURI_ENV_DEBUG === "true" },
})
