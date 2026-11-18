# Galiot — Technology Stack & Toolchain

> **⚠️ Hosting correction (2026-09-24):** the hosting and cost statements in
> this document are obsolete. Galiot's build output is a static bundle that any
> static host or edge CDN can serve; the provider is an interchangeable
> implementation detail, not a design constraint. See
> [docs/STACK_DECISION.md](docs/STACK_DECISION.md) for the decision log. This
> file is kept as the original spec; corrections live there.
>
> **⚠️ Architecture correction (2026-11-17):** Galiot is self-hosted; the Bun
> server signs every S3 request (vendored aws4fetch) and opens the connection,
> and the browser only calls same-origin `/api/s3`. A static file host cannot
> run Galiot — the 2026-09-24 "any static host or edge CDN" line above is
> superseded. Current model: [docs/OPERATIONS.md](docs/OPERATIONS.md) and
> [docs/STACK_DECISION.md](docs/STACK_DECISION.md) §22.


> *A deep dive into the modern web and build stack powering Galiot, focusing on **Bun 1.4**, **PGlite**, and modern browser APIs.*

---

## 1. Stack Overview

Galiot combines a 100% client-side React frontend with a high-performance WASM database engine and Bun 1.4 build tooling:

```
+───────────────────────────────────────────────────────────────────────────────────+
|                                  GALIOT STACK                                     |
+───────────────────────────────────────────────────────────────────────────────────+
|  HOSTING / CDN       | GitHub Pages (Static hosting at $0 cost)                   |
|  BUILD / TOOLCHAIN   | Bun 1.4 (Rust Core, Bun package manager, fast Vite bundler)|
|  CLIENT (Browser)    | React 19 + TailwindCSS v4 + Monaco Editor + Lucide Icons   |
|  LOCAL DATABASE      | PGlite (WASM Postgres 16) + OPFS (Origin Private File Sys) |
|  REACTIVE STATE      | ElectricSQL live.query() / @electric-sql/pglite-react      |
|  BROWSER FILE ACCESS | HTML5 File System Access API (window.showDirectoryPicker)  |
|  SECURITY VAULT      | WebCrypto API (SubtleCrypto AES-GCM-256 + PBKDF2)          |
|  OPTIONAL COMPANION  | Bun 1.4 Streaming HTTP Reverse Proxy (CORS bypass & SFTP)  |
+───────────────────────────────────────────────────────────────────────────────────+
```

---

## 2. Bun 1.4 as the Primary Build & DX Toolchain

In Galiot, **Bun 1.4** (the August 2026 release rewritten from Zig to Rust) serves as the primary development and build powerhouse:

### 2.1 Why Bun 1.4 for a Static GitHub Pages Project?
1. **Sub-Second Static Site Generation**:
   - `bun run build` packages React 19, Tailwind v4, Monaco Editor, and the PGlite WASM asset pipeline into `dist/` in under 800ms.
2. **Instant Package Installation**:
   - `bun install --frozen-lockfile` runs in ~150ms, speeding up GitHub Actions CI workflows for GitHub Pages deployments.
3. **Rust Architectural Core**:
   - Provides rock-solid stability and zero memory leaks during automated build scripts and end-to-end integration test runs.
4. **Built-in Test Runner**:
   - `bun test` runs unit tests for SQL queries, S3 SigV4 signature generators, and cryptographic key derivation routines in parallel.

---

## 3. PGlite: Running PostgreSQL 16 Inside the Browser

- **Zero-Dependency Database**: Runs genuine PostgreSQL 16 compiled to WebAssembly without requiring a Docker container or external database daemon.
- **OPFS Persistence**: Saves all table data to the browser's Origin Private File System using synchronous access handles (`createSyncAccessHandle`), unlocking I/O speeds up to 10x faster than IndexedDB.
- **ElectricSQL Live Queries**: The React interface updates automatically whenever database records change, eliminating Redux, Zustand, or custom event buses.

---

## 4. Frontend Application Layer

### 4.1 React 19 & TailwindCSS v4
- **TanStack Virtual**: Powers 60 FPS scrolling through bucket directories containing 100,000+ objects without DOM strain.
- **TailwindCSS v4**: Semantic tokens matched to Galeon's design system:
  - Zinc palette (`zinc-900`, `zinc-950`) for a clean dark/light mode interface.
  - Gale Teal (`#0d9488`) for interactive highlights and primary navigation.
  - Doubloon Amber (`#d97706`) for transfer progress bars and bandwidth metrics.

### 4.2 In-Browser Monaco Editor
- Full VS Code editing engine embedded into a drawer/modal.
- Syntax highlighting for 100+ file extensions (JSON, YAML, Python, Markdown, Rust, SQL).
- Side-by-side Git-style visual diff: see exact line changes before uploading modified files back to the cloud.

### 4.3 HTML5 File System Access API
- Mounts local computer directories into the dual-pane UI via `window.showDirectoryPicker()`.
- Supports bidirectional drag-and-drop between the local folder and cloud storage buckets.
