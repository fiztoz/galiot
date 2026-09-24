# Galiot — Implementation Roadmap

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
- [ ] **3.3 Dual-Pane Mode with File System Access API**:
  - Mount user-selected computer folders (`window.showDirectoryPicker()`) into the left pane.
  - Enable bidirectional drag-and-drop between the local folder and the remote cloud bucket.
- [ ] **3.4 Transfer Drawer**:
  - Render a slide-out transfer monitor displaying active speeds, ETA, bandwidth graphs, and error retry actions.

---

## Phase 4: In-Browser Editor, Previews & Sharing

**Goal**: Provide in-browser productivity tools that surpass desktop file-watcher workflows.

- [ ] **4.1 Embedded Monaco Editor**:
  - Embed Monaco Editor for direct in-browser editing of JSON, YAML, Python, Markdown, and configuration files.
  - Build side-by-side visual diff viewer to inspect changes before re-uploading to S3.
- [ ] **4.2 Media & Document Previews**:
  - High-performance image viewer with zoom/pan.
  - Native PDF preview and audio/video streaming players.
- [ ] **4.3 Presigned URL Generator & History**:
  - Generate download and upload grants with custom expiration policies (1 hour, 24 hours, 7 days).
  - Persist generated links in `presigned_history` with one-click revocation.

---

## Phase 5: Polish, Benchmarks & GitHub Pages Launch

**Goal**: Ensure enterprise-grade transfer integrity, security verification, and release to GitHub Pages.

- [ ] **5.1 1-Click CORS Helper**:
  - Add interactive CORS diagnostics tool to test bucket settings and generate/apply CORS policies automatically.
- [ ] **5.2 Transfer Integrity Test Suite**:
  - Automated MinIO test suite verifying MD5/SHA256 checksums on parallel uploads, aborted parts, and network blip resumes.
- [ ] **5.3 Performance Benchmarks**:
  - Benchmark listing speed and memory usage against Galeon Desktop and Cyberduck.
- [ ] **5.4 Launch to GitHub Pages**:
  - Publish public live demo and documentation at `https://<username>.github.io/galiot`.
