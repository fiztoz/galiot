# Galiot — System Architecture

> **⚠️ Hosting correction (2026-09-24):** this document predates the hosting
> decision and still describes **GitHub Pages**. Galiot ships to **Cloudflare
> Workers Static Assets** (free tier, $0, static requests free & unlimited).
> See [docs/STACK_DECISION.md](docs/STACK_DECISION.md) §6, §12 and §13 for the verified decision and sources.
> This file is kept as the original spec; corrections live in that log.

> *A comprehensive architectural blueprint for porting Galeon's desktop client paradigm to a 100% client-side web application hosted for free on GitHub Pages.*

---

## 1. Naming & Brand Positioning: Galiot

- **Name**: **Galiot** *(historically: galiot, galeot, or galiote)*
- **Lineage**: The agile, fast-maneuvering cousin craft developed by the same shipwrights who built galleons. Where the heavy galleon ruled transatlantic deep waters, the galiot dominated swift coastal operations, riverways, and rapid exploration.
- **Tagline**: *"Chart your cloud from any browser."*
- **Visual Motif**: A sleek, single-deck vessel with lateen rigging, drawn in modern, minimalist, geometric strokes using Galeon's Gale Teal (`#0d9488`) and Zinc palette.

---

## 2. The Architectural Paradigm: 100% Client-Side on GitHub Pages

Galiot is engineered specifically to run **entirely client-side** so it can be hosted at **$0 infrastructure cost** on **GitHub Pages** (or Cloudflare Pages / Vercel):

```
+───────────────────────────────────────────────────────────────────────────+
|                      GALIOT FULL CLIENT-SIDE TOPOLOGY                     |
+───────────────────────────────────────────────────────────────────────────+
|                                                                           |
|   1. GITHUB PAGES STATIC HOSTING                                          |
|      ├── index.html                                                       |
|      ├── galiot-bundle.js (React 19 + Tailwind v4 + Monaco Editor)        |
|      ├── pglite.wasm (Compiled PostgreSQL 16 WebAssembly binary)         |
|      └── Zero server backends, zero microservices, zero ongoing cost      |
|                                                                           |
|   2. BROWSER RUNTIME ENVIRONMENT (User's Device)                          |
|      ├── Main Thread:                                                     |
|      │   ├── 60 FPS Virtualized Explorer Table/Grid                       |
|      │   ├── Dual-Pane: Remote Bucket <-> Local Folder Mount              |
|      │   └── Command Palette (Cmd + K) & Keyboard Nav                     |
|      │                                                                    |
|      ├── Web Worker 1: PGlite WASM Database Engine                         |
|      │   ├── Runs pure PostgreSQL inside WebAssembly                      |
|      │   ├── Direct sync I/O to Origin Private File System (OPFS)         |
|      │   └── ElectricSQL live.query() pushes state to React components    |
|      │                                                                    |
|      ├── Web Worker 2+: Parallel Transfer Pipeline                        |
|      │   ├── S3 Multipart chunk slicing (8MB - 64MB parts)                |
|      │   └── Range-based parallel downloads with SHA256 verification      |
|      │                                                                    |
|      └── WebCrypto Subsystem:                                             |
|          └── Master password / Passkey -> PBKDF2 -> AES-GCM-256 Vault     |
|                                                                           |
|   3. EXTERNAL CONNECTIVITY (Direct HTTPS / REST)                          |
|      ├── AWS S3 / Cloudflare R2 / MinIO / Backblaze B2 / Supabase Storage |
|      └── Communicates directly via HTTPS (requires standard bucket CORS)  |
|                                                                           |
+───────────────────────────────────────────────────────────────────────────+
```

---

## 3. Web Sandbox Solutions

### 3.1 S3 Direct REST & CORS Handling
Because Galiot runs purely in the browser without a proxy backend, browser security requires S3 buckets to have CORS enabled:
- **Direct S3 Connectivity**: The browser issues standard AWS SigV4 signed REST requests directly to the cloud provider.
- **1-Click Built-in CORS Helper**: 
  - Galiot includes a pre-flight CORS checker in the connection wizard.
  - If the user provides credentials with `s3:PutBucketCors` permissions, Galiot can automatically inject the optimal CORS policy into the bucket with a single click.
  - Alternatively, Galiot provides copy-paste ready CORS JSON/XML snippets tailored for Cloudflare R2, AWS S3, MinIO, and Backblaze B2.

### 3.2 File System Access API (Dual-Pane Mode)
Desktop Galeon uses `std::fs` to access the local hard drive. Galiot delivers dual-pane parity through web standards:
- **`window.showDirectoryPicker()`**: Allows the user to select any folder on their computer (e.g., `~/Documents/Projects`).
- **Persistent Access**: Modern browsers (Chrome, Edge, Opera) allow granting persistent read/write handles across reloads.
- **Direct Streaming**: Files dragged from the S3 bucket into the local pane are streamed directly onto the user's hard drive using `FileSystemWritableFileStream` without buffering entire gigabytes in RAM.

### 3.3 Zero-Knowledge Security Vault (No OS Keyring Needed)
Browsers do not have direct access to the macOS Keychain or Windows Credential Manager. Galiot replaces this with an in-browser zero-knowledge cryptographic vault:
1. **Passkey / Master Password**: The user chooses an optional master password or activates biometric authentication via **WebAuthn / Passkeys**.
2. **Key Derivation**: Uses WebCrypto `SubtleCrypto.deriveKey()` with PBKDF2 (100,000+ iterations) or Argon2 WASM.
3. **AES-GCM-256 Encryption**: All access keys, secret keys, and endpoint configurations are encrypted client-side before being written to PGlite in OPFS.
4. **Zero Telemetry**: No credentials, bucket names, or file names are ever transmitted to any third-party server or analytic service.

### 3.4 In-Browser Monaco Editor (Replacing External App Spawning)
Desktop Galeon launches local binaries like VS Code or TextEdit. In Galiot:
- **Embedded Monaco Editor**: The exact editor engine powering VS Code is embedded directly into Galiot.
- **Side-by-Side Visual Diff**: When you edit a remote configuration file (JSON, YAML, Markdown, Python), Galiot shows a split diff of your changes against the live S3 version before you click "Save & Upload".

---

## 4. Optional Companion Server (Bun 1.4)

While Galiot on GitHub Pages is **100% functional standalone**, users who require advanced capabilities can run an optional local companion server powered by **Bun 1.4**:
- **Bypass CORS for Private MinIO**: A single-line command (`bun run proxy`) lets Bun act as an ultra-fast streaming HTTP reverse proxy.
- **SFTP / SSH Tunneling**: Bun bridges browser WebSockets into raw TCP connections for remote SFTP servers.
- **Headless Background Sync**: Continuous folder synchronization powered by `Bun.cron`.
