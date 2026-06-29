import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import electron from "vite-plugin-electron/simple";
import path from "node:path";

export default defineConfig({
  plugins: [
    vue(),
    electron({
      main: {
        entry: "electron/main.ts",
        vite: {
          build: {
            rollupOptions: {
              external: [
                "@earendil-works/pi-ai",
                "@earendil-works/pi-coding-agent",
                "better-sqlite3",
                "axios",
              ],
            },
          },
        },
      },
      preload: {
        input: path.join(__dirname, "electron/preload.ts"),
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
  },
});
