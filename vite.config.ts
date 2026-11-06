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
    // Off by default. Maps are ~5 MB of a ~23 MB dist, and Cloudflare Workers
    // Assets publishes everything in dist/ (Vercel at least 403s .map files).
    // Opt in locally with: GALIOT_SOURCEMAPS=1 bun run build
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
