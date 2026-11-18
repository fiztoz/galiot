import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { s3ProxyPlugin } from "./src/server/vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), s3ProxyPlugin()],
  resolve: {
    alias: {
      "@": import.meta.dirname + "/src",
    },
  },
  base: "/",
  build: {
    target: "es2022",
    outDir: "dist",
    // Off by default: maps are ~5 MB of readable source and the self-hosted
    // server serves everything in dist/. Opt in locally with:
    // GALIOT_SOURCEMAPS=1 bun run build
    sourcemap: process.env.GALIOT_SOURCEMAPS === "1",
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("@electric-sql/pglite")) {
            return "pglite";
          }
          return undefined;
        },
      },
    },
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["@electric-sql/pglite"],
  },
});
