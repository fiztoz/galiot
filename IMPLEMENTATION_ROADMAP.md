# Galiot — Implementation Roadmap

> **⚠️ Hosting correction (2026-09-24):** the hosting and cost statements in
> this document are obsolete. Galiot's build output is a static bundle that any
> static host or edge CDN can serve; the provider is an interchangeable
> implementation detail, not a design constraint. See
> [docs/STACK_DECISION.md](docs/STACK_DECISION.md) for the decision log. This
> file is kept as the original spec; corrections live there.


> *A phased engineering roadmap for building Galiot as a 100% client-side web application hosted on GitHub Pages.*

---

## Phase 1: Core Foundation & PGlite WASM Worker

**Goal**: Establish a lightning-fast browser foundation running PostgreSQL in WebAssembly, backed by OPFS.

- [x] **1.1 Workspace & Toolchain Setup**:
  - Initialize Bun 1.4-powered Vite workspace with React 19, TypeScript 5.8+, and TailwindCSS v4.
  - Set up automated GitHub Actions workflow to build and deploy static assets to `gh-pages` on push.
- [x] **1.2 PGlite Worker Integration**:
  - Implement dedicated Web Worker (`pglite.worker.ts`) hosting `@electric-sql/pglite`.
  - Configure OPFS (Origin Private File System) persistence with IndexedDB fallback.
  - Run initial schema migrations (`profiles`, `objects_cache`, `transfer_tasks`, `transfer_parts`).
- [x] **1.3 WebCrypto Zero-Knowledge Vault**:
  - Implement client-side AES-GCM-256 encryption for S3 credentials.
  - Derive encryption keys using PBKDF2 from user master password or WebAuthn/Passkey.
- [ ] **1.4 Direct S3 Client**:
  - Implement lightweight, streaming S3 client utilizing AWS SigV4 fetch.
  - Test connection and CORS preflight against Cloudflare R2 and MinIO.
  - **MinIO half verified 2026-09-25** against a live container
    (`./scripts/minio-test.sh`): connection test, CORS diagnosis and remediation,
    SigV4 signing, listing, multipart, resume, ranges, presigned links and
    multi-delete. It surfaced four real defects, now fixed and recorded in
    `docs/STACK_DECISION.md` §15 — including two that broke MinIO completely
    (an empty `continuation-token` and a double-encoded canonical URI).
  - **Still open: Cloudflare R2**, which needs real account credentials. Left
    unticked deliberately rather than claiming a provider that was not exercised.

---

## Phase 2: Reactive Object Explorer & SQL Engine

**Goal**: Deliver a 60 FPS, virtualized file browser capable of handling hundreds of thousands of objects.

- [x] **2.1 Virtualized Grid & Table Views**:
  - Integrate `@tanstack/react-virtual` for virtualized rendering of 100,000+ objects without DOM strain.
  - Implement multi-select (`Shift + Click`, `Cmd + Click`, lasso selection) matching Galeon desktop behavior.
- [x] **2.2 Reactive Live Queries**:
  - Connect React components to PGlite via `@electric-sql/pglite-react` (`useLiveQuery`).
  - Eliminate custom global state stores for object listings; let SQL drive the UI.
- [x] **2.3 Instant SQL Search & Filtering**:
  - Implement trigram-based instant fuzzy searching across object names.
  - Filter by date range, size threshold, and storage class directly via SQL queries.
- [x] **2.4 Recursive Folder Size Calculation**:
  - Implement recursive CTE queries to roll up directory statistics on hover or demand.

---

## Phase 3: Transfer Engine & Dual-Pane Local Mode

**Goal**: Implement a fault-tolerant, parallelized chunk transfer pipeline and HTML5 local directory mounting.

- [x] **3.1 Multipart Parallel Upload Pipeline**:
  - Build Web Worker upload pool splitting files into 8MB - 64MB parts.
  - Record uploaded part ETags in PGlite `transfer_parts` table.
  - Enable automatic pause, resume, and cancellation across network disconnects or page reloads.
- [x] **3.2 Resumable Range-Based Downloads**:
  - Stream downloads using HTTP `Range` headers into OPFS temporary files or directly into writable streams.
- [x] **3.3 Dual-Pane Mode with File System Access API**:
  - Mount user-selected computer folders (`window.showDirectoryPicker()`) into the left pane.
  - Enable bidirectional drag-and-drop between the local folder and the remote cloud bucket.
  - Read-only `<input webkitdirectory>` fallback where the File System Access API is missing.
- [x] **3.4 Transfer Drawer**:
  - Render a slide-out transfer monitor displaying active speeds, ETA, bandwidth graphs, and error retry actions.

---

## Phase 4: In-Browser Editor, Previews & Sharing

**Goal**: Provide in-browser productivity tools that surpass desktop file-watcher workflows.

- [x] **4.1 Embedded CodeMirror 6 Editor** (CodeMirror supersedes the Monaco wording here — see `docs/STACK_DECISION.md` §3):
  - Embed CodeMirror 6 for direct in-browser editing of JSON, YAML, Python, Markdown, and configuration files.
  - Build side-by-side visual diff viewer to inspect changes before re-uploading to S3.
- [x] **4.2 Media & Document Previews**:
  - High-performance image viewer with zoom/pan.
  - Native PDF preview and audio/video streaming players.
- [x] **4.3 Presigned URL Generator & History**:
  - Generate download and upload grants with custom expiration policies (1 hour, 24 hours, 7 days).
  - Persist generated links in `presigned_history`. Note: a presigned URL is a self-contained bearer token, so it cannot be revoked server-side — the UI states this and offers record removal plus the real remedy (rotating the signing key).

---

## Phase 5: Polish, Benchmarks & GitHub Pages Launch

**Goal**: Ensure enterprise-grade transfer integrity, security verification, and release to GitHub Pages.

- [x] **5.1 1-Click CORS Helper**:
  - Add interactive CORS diagnostics tool to test bucket settings and generate/apply CORS policies automatically.
- [x] **5.2 Transfer Integrity Test Suite**:
  - Automated MinIO test suite verifying MD5/SHA256 checksums on parallel uploads, aborted parts, and network blip resumes. (`bun run test:integrity`)
- [x] **5.3 Performance Benchmarks**:
  - Benchmark listing speed and memory usage against Galeon Desktop and Cyberduck. (`bun run bench`; engine results in [`benchmarks/ENGINE.md`](benchmarks/ENGINE.md); Galeon/Cyberduck comparison still needs a desktop run)
- [ ] **5.4 Launch** (operational work: hosting decision, deploy secrets, real-bucket verification — tracked in [`LAUNCH.md`](LAUNCH.md))
