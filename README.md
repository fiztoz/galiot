# Galiot — The Agile Cloud Explorer

> *A 100% client-side, local-first cloud & object storage web client inspired by **Galeon**, powered by **PGlite** (WASM Postgres) and **Bun 1.4**, hosted free on **GitHub Pages**.*

---

## 1. Executive Summary

**Galeon** is a fast, lightweight desktop client for S3, SFTP, and remote storage built with Tauri v2 and Rust.

**Galiot** is its agile, web-native cousin. Where Galeon serves as the heavy native desktop flagship (with direct access to the OS keychain and local binaries), Galiot brings that same high-performance, keyboard-first, and zero-telemetry experience **directly into any web browser**.

### The Core Architectural Pillars:
1. **100% Client-Side & Local-First**: Zero server required. Runs as a static web app hosted for free on **GitHub Pages** (or Cloudflare Pages).
2. **PGlite WASM Engine**: Runs genuine PostgreSQL 16 compiled to WebAssembly inside a browser Web Worker, persisting data locally to the browser's **Origin Private File System (OPFS)**.
3. **Direct S3 Connectivity**: Speaks directly to AWS S3, Cloudflare R2, MinIO, Wasabi, and Backblaze B2 using standard S3 REST over HTTPS (with bucket CORS).
4. **HTML5 Dual-Pane Local Explorer**: Mounts local computer directories using the **File System Access API** (`window.showDirectoryPicker()`).
5. **In-Browser Monaco Editor**: Inspect, edit, and diff remote files directly in the browser before saving back to the bucket.
6. **Bun 1.4 Toolchain**: Developed and bundled with Bun 1.4 for sub-second builds and instant static packaging.

---

## 2. The Name: Why "Galiot"?

In maritime history:
- **The Galleon** (*Galeon*): A heavy, multi-deck ship of the line built to carry immense cargo across transatlantic ocean routes. Sturdy and deep-drafted.
- **The Galiot** (*Galeot* / *Galiote*): A smaller, nimble, fast-sailing vessel developed by the same Mediterranean and Atlantic shipwrights. Designed for quick coastal maneuvering, shallow waters, and rapid voyages where a heavy galleon could not navigate.

### The Metaphor
- **Galeon** is the heavy desktop flagship with full OS-level capabilities.
- **Galiot** is the nimble, zero-install web vessel that navigates any browser tab, tablet, or workstation instantly.

---

## 3. High-Level Architecture

```
+───────────────────────────────────────────────────────────────────────────+
|                           GALIOT ARCHITECTURE                             |
|                (100% Static Deployment on GitHub Pages)                   |
+───────────────────────────────────────────────────────────────────────────+
|                                                                           |
|   Static Web Host (GitHub Pages / Free CDN)                               |
|   └── Serves static bundle: index.html + JS + CSS + pglite.wasm           |
|                                                                           |
|   User's Browser (Chrome / Safari / Edge / Firefox)                       |
|   ├── React 19 UI Layer (TailwindCSS v4 + TanStack Virtual + Lucide)      |
|   │   ├── Dual-Pane Explorer (Local Drive <-> Remote Bucket)              |
|   │   ├── Built-in Monaco Editor with side-by-side visual diff            |
|   │   └── Command Palette (Cmd + K) and keyboard-first shortcuts          |
|   │                                                                       |
|   ├── PGlite WASM Engine (Web Worker Thread)                              |
|   │   ├── Genuine PostgreSQL 16 compiled to WebAssembly                   |
|   │   ├── Data persists to OPFS (Origin Private File System) on disk      |
|   │   ├── Instant B-Tree & Trigram indexed search over 500k+ objects      |
|   │   ├── Recursive CTEs for instant directory size rollups               |
|   │   └── ElectricSQL live.query() reactive state updates                 |
|   │                                                                       |
|   ├── WebCrypto Security Vault (SubtleCrypto)                             |
|   │   └── AES-GCM-256 encryption for S3 credentials (zero server leaks)   |
|   │                                                                       |
|   └── S3 Transfer Pipeline                                                |
|       ├── Parallel Web Worker chunked multipart uploads                   |
|       ├── Range-based resumable downloads                                 |
|       └── Direct HTTPS fetch to S3 endpoint (AWS, R2, MinIO with CORS)    |
|                                                                           |
+───────────────────────────────────────────────────────────────────────────+
```

---

## 4. Documentation Index

The complete research and technical specification suite for Galiot:

| Document | Description |
|---|---|
| [**docs/STACK_DECISION.md**](docs/STACK_DECISION.md) | Verified stack comparison with sources, provisional decisions, and corrections to earlier specs (2026-09-17; pass 3 2026-09-18). |
| [**docs/FEASIBILITY_AND_RISKS.md**](docs/FEASIBILITY_AND_RISKS.md) | Browser feasibility pass: Postgres 18.3, memory-resident IDB VFS, Safari 7-day storage deletion, part-buffered S3 uploads, and the revised Phase 1 spike list (2026-09-18). |
| [**docs/HOSTING_COMPARISON.md**](docs/HOSTING_COMPARISON.md) | Free-tier hosting shootout for a public non-commercial OSS app: bandwidth, custom headers, billing risk. Recommendation: Cloudflare Pages (GitHub Pages demoted to docs mirror). |
| [**SECURITY_DEEP_DIVE.md**](SECURITY_DEEP_DIVE.md) | Comprehensive security threat model: WebAuthn PRF Passkey vault, memory zeroing, CSP, browser extension defense, and untrusted file sandboxing. |
| [**ARCHITECTURE.md**](ARCHITECTURE.md) | Full architectural blueprint: client-only PWA, CORS solutions, security vault, and browser APIs. |
| [**PGLITE_SPEC.md**](PGLITE_SPEC.md) | Complete WASM Postgres blueprint: schema, OPFS storage worker, live reactive queries, CTEs, and vector search. |
| [**TECH_STACK.md**](TECH_STACK.md) | Technical stack deep dive: Bun 1.4, React 19, Tailwind v4, Monaco Editor, and browser storage APIs. |
| [**GALEON_PARITY_MATRIX.md**](GALEON_PARITY_MATRIX.md) | Feature-by-feature parity analysis comparing Galeon (Desktop) with Galiot (Web). |
| [**IMPLEMENTATION_ROADMAP.md**](IMPLEMENTATION_ROADMAP.md) | Phased engineering implementation roadmap from Phase 1 to production launch. |
| [**NAMING_CANDIDATES.md**](NAMING_CANDIDATES.md) | Archive of the naming evaluation and brand decision history. |

---

## 5. Comparison: Galeon vs. Galiot

| Dimension | Galeon (Desktop) | Galiot (Web / GitHub Pages) |
|---|---|---|
| **Form Factor** | Desktop App (.dmg, .exe, .deb) | 100% Client-Side Web App |
| **Hosting Cost** | N/A (Local Install) | **$0 (GitHub Pages / Cloudflare Pages)** |
| **Core Runtime** | Tauri v2 + Rust + tokio | Browser (V8/JSC) + WebAssembly |
| **Build Toolchain** | Bun + Cargo | **Bun 1.4** + Vite |
| **Catalog Database** | In-memory HashMap / JSON | **PGlite (WASM Postgres in OPFS)** |
| **Query Engine** | Linear scan | Full PostgreSQL (SQL, CTEs, Indexes) |
| **Credentials** | OS Keyring (macOS Keychain, etc.) | WebCrypto AES-GCM-256 Vault |
| **Local File Access** | Unrestricted `std::fs` | HTML5 File System Access API |
| **File Editing** | Spawns external VS Code binary | Built-in Monaco Editor with side-by-side diff |
| **S3 Protocol** | Direct TCP via OpenDAL | Direct HTTPS REST (CORS enabled) |
| **Telemetry / Tracking**| Zero (Privacy first) | Zero (Privacy first, 100% local) |
