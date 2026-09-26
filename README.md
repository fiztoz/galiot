# Galiot — The Agile Cloud Explorer

> *A 100% client-side, local-first cloud & object storage web client inspired by **Galeon**, powered by **PGlite** (WASM Postgres) and **Bun 1.4**. Ships as a static bundle — host it anywhere.*

---

## 1. Executive Summary

**Galeon** is a fast, lightweight desktop client for S3, SFTP, and remote storage built with Tauri v2 and Rust.

**Galiot** is its agile, web-native cousin. Where Galeon serves as the heavy native desktop flagship (with direct access to the OS keychain and local binaries), Galiot brings that same high-performance, keyboard-first, and zero-telemetry experience **directly into any web browser**.

### The Core Architectural Pillars:
1. **100% Client-Side & Local-First**: Zero server required. The build output is a plain static bundle, so it can be served by any static host, edge CDN or object-storage front door — no backend, no vendor lock-in.
2. **PGlite WASM Engine**: Runs genuine PostgreSQL 18.3 compiled to WebAssembly inside a browser Web Worker, persisting data locally to the browser's **Origin Private File System (OPFS)**.
3. **Direct S3 Connectivity**: Speaks directly to AWS S3, Cloudflare R2, MinIO, Wasabi, and Backblaze B2 using standard S3 REST over HTTPS (with bucket CORS).
4. **HTML5 Dual-Pane Local Explorer**: Mounts local computer directories using the **File System Access API** (`window.showDirectoryPicker()`).
5. **In-Browser CodeMirror 6 Editor**: Edit remote files with real language support, review a side-by-side diff, then save straight back to the bucket. Images, PDFs, audio and video preview natively.
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
| (100% Static Deployment — host it anywhere)                              |
+───────────────────────────────────────────────────────────────────────────+
|                                                                           |
| Any static host or edge CDN (vendor-neutral)                             |
|   └── Serves static bundle: index.html + JS + CSS + pglite.wasm           |
|   (served with CSP / COOP / COEP / HSTS where the host supports headers) |
|                                                                           |
|   User's Browser (Chrome / Safari / Edge / Firefox)                       |
|   ├── React 19 UI Layer (TailwindCSS v4 + TanStack Virtual + Lucide)      |
|   │   ├── Dual-Pane Explorer (Local Drive <-> Remote Bucket)              |
|   │   ├── Built-in CodeMirror 6 editor with side-by-side diff           |
|   │   └── Command Palette (Cmd + K) and keyboard-first shortcuts          |
|   │                                                                       |
|   ├── PGlite WASM Engine (Web Worker)                                      |
|   │   ├── Genuine PostgreSQL 18.3 compiled to WebAssembly                  |
|   │   ├── Persists to OPFS (IDB fallback) — profiles, cache, ledger       |
|   │   ├── Trigram-indexed search, recursive CTE folder roll-ups            |
|   │   └── live.query() drives the UI, no global state store               |
|   │                                                                       |
|   ├── Vault Worker (Web Worker)                                            |
|   │   ├── PBKDF2-600k → AES-KW unwrap → AES-GCM-256 for S3 credentials     |
|   │   ├── Holds the DEK and every signed request (15-min idle auto-lock)   |
|   │   └── Signs requests for the transfer worker over a MessagePort        |
|   │                                                                       |
|   ├── Transfer Worker (Web Worker)                                         |
|   │   ├── Parallel multipart uploads with pause/resume + part ledger      |
|   │   └── Range-based resumable downloads into OPFS or a local folder     |
|   │                                                                       |
|   └── UI (main thread)                                                     |
|       ├── Virtualized list/grid explorer: multi-select, lasso, filters    |
|       ├── CodeMirror 6 editor + diff, media previews, presigned links     |
|       └── Direct HTTPS to the S3 endpoint (AWS, R2, MinIO… with CORS)     |
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
| [**docs/HOSTING_COMPARISON.md**](docs/HOSTING_COMPARISON.md) | Free-tier hosting shootout for a public non-commercial OSS app: bandwidth, custom headers, billing risk. Dated research pass; its recommendation is superseded — see STACK_DECISION §12–13. Hosting is treated as an interchangeable implementation detail, not a design constraint. |
| [**SECURITY_DEEP_DIVE.md**](SECURITY_DEEP_DIVE.md) | Comprehensive security threat model: WebAuthn PRF Passkey vault, memory zeroing, CSP, browser extension defense, and untrusted file sandboxing. |
| [**ARCHITECTURE.md**](ARCHITECTURE.md) | Full architectural blueprint: client-only PWA, CORS solutions, security vault, and browser APIs. |
| [**PGLITE_SPEC.md**](PGLITE_SPEC.md) | Complete WASM Postgres blueprint: schema, OPFS storage worker, live reactive queries, CTEs, and vector search. |
| [**TECH_STACK.md**](TECH_STACK.md) | Original stack deep dive (Bun 1.4, React 19, Tailwind v4, editor choice, browser storage APIs). Its editor choice was superseded — see STACK_DECISION §3. |
| [**GALEON_PARITY_MATRIX.md**](GALEON_PARITY_MATRIX.md) | Feature-by-feature parity analysis comparing Galeon (Desktop) with Galiot (Web). |
| [**IMPLEMENTATION_ROADMAP.md**](IMPLEMENTATION_ROADMAP.md) | Phased engineering implementation roadmap from Phase 1 to production launch. |
| [**NAMING_CANDIDATES.md**](NAMING_CANDIDATES.md) | Archive of the naming evaluation and brand decision history. |
| [**benchmarks/ENGINE.md**](benchmarks/ENGINE.md) | Measured engine performance: listing, search, filters and roll-up latency at 10k/100k objects. |

---

## 5. Comparison: Galeon vs. Galiot

| Dimension | Galeon (Desktop) | Galiot (Web) |
|---|---|---|
| **Form Factor** | Desktop App (.dmg, .exe, .deb) | 100% Client-Side Web App |
| **Hosting** | N/A (Local Install) | Any static host / edge CDN; no backend to operate |
| **Core Runtime** | Tauri v2 + Rust + tokio | Browser (V8/JSC) + WebAssembly |
| **Build Toolchain** | Bun + Cargo | **Bun 1.4** + Vite |
| **Catalog Database** | In-memory HashMap / JSON | **PGlite (WASM Postgres in OPFS)** |
| **Query Engine** | Linear scan | Full PostgreSQL (SQL, CTEs, Indexes) |
| **Credentials** | OS Keyring (macOS Keychain, etc.) | WebCrypto AES-GCM-256 Vault |
| **Local File Access** | Unrestricted `std::fs` | HTML5 File System Access API |
| **File Editing** | Spawns external VS Code binary | Built-in CodeMirror 6 with side-by-side diff |
| **S3 Protocol** | Direct TCP via OpenDAL | Direct HTTPS REST (CORS enabled) |
| **Telemetry / Tracking**| Zero (Privacy first) | Zero (Privacy first, 100% local) |

---

## 6. Importing connections from Galeon

**Connections → Import from Galeon** reads a Galeon profile export (`galeon.profiles`,
version 1) and brings its S3 connections across.

In Galeon, export with **include credentials** checked. Galeon strips the keys
otherwise, and a connection without keys cannot be imported — the dialog says so
per profile rather than importing something that cannot work.

What the importer handles:

- **All three file shapes** Galeon accepts: the `galeon.profiles` envelope, a
  bare profiles array, and a `config.json` snapshot.
- **Field mapping**: endpoint (with a scheme inferred for bare hosts, `http` for
  self-hosted ones), region (defaulting to `us-east-1`), bucket, storage class,
  and addressing — Galeon's `useVirtualHostStyle` is the inverse of Galiot's
  `path_style`, and when Galeon left it unset the importer infers it from the
  endpoint, because an unset value means virtual-hosted on AWS but path-style on
  a self-hosted MinIO.
- **Skips it must skip**: non-S3 profiles (Galiot is S3-only) and profiles with
  no credentials, each with the reason shown in the dialog.
- **Refuses what should not be imported silently**: Galeon's "disable TLS
  verification" flag is reported and dropped — Galiot always verifies TLS.

**Credentials are parsed and encrypted in the vault worker.** The file is handed
to the worker, which reads the keys, seals them with the vault's DEK and returns
only ciphertext; the preview the page renders contains no key material, and the
file text is re-read from the file handle per call rather than held in component
state. A file swapped between preview and confirm is rejected via a content hash
instead of importing something you did not review.

There is deliberately **no export back to Galeon**: Galiot's stored credentials
are ciphertext sealed by a key that only exists in the vault worker, so
producing a plaintext Galeon profile would mean decrypting secrets onto the main
thread. Galeon remains the tool for those connections.

---

## 7. Editing a connection

Every connection is editable — hover a card for the pencil icon. Name, endpoint,
region, bucket, addressing and credentials can all change, and the same
diagnostics, CORS helper and connection test run inside the editor.

**The stored keys are kept unless you replace them.** The editor shows the key
fields blank with an "unchanged — type to replace" placeholder, because the
sealed credentials are never decrypted on the main thread just to populate an
input. Type both to rotate them, leave both blank to keep them, and type only
one and the save is refused rather than leaving a half-replaced pair.

*Test connection* works without retyping: the worker uses the sealed blob already
stored, so you can re-point a bucket and verify it in one go.

Two consequences of editing, by design:

- **The cached listing is dropped when the target changes** (endpoint, region,
  bucket or addressing), since those rows came from a different bucket. Renaming
  keeps the cache. Transfer history and presigned links are kept: a transfer
  carries its own target snapshot, and a presigned URL stays valid until it
  expires and cannot be revoked anyway.
- **A refused request is no longer reported as CORS.** A `403` or `404` arrives
  from the bucket with its CORS headers intact, so the browser did not block
  anything; the diagnostics now say so, and point at the keys, the bucket name or
  permissions instead of offering a CORS policy that cannot help.

---

## 8. Fixing CORS from a terminal, with nothing pre-configured

When a bucket has no CORS policy, the browser blocks the very request that would
write one — so Galiot cannot fix it from the page. The CORS helper offers
commands for that, and **none of them assume you have set anything up first**,
which matters because you cannot configure `mc` or the AWS CLI until you have a
profile, and you cannot get a profile until CORS is fixed.

| Option | What you need |
|---|---|
| **curl** | Nothing. `curl` is already on your machine |
| **MinIO client (`mc`)** | The `mc` binary only — the command creates and then removes its own alias |
| **AWS CLI (`aws`)** | The `aws` binary only — the command sets its own environment |
| **Provider dashboard** | Your provider's web console — paste the JSON |

The curl path is the shortest: Galiot presigns the `PutBucketCors` request in the
vault worker and prints a complete copy-paste block. The URL carries a signature
scoped to that one request, valid for an hour — **the secret key is never in the
command**, and the request is not from a browser, so CORS does not apply.

The `mc` and `aws` commands prompt for the keys rather than embedding them, so
they do not end up in your shell history. Tick *Fill in my keys* if you would
rather paste once, and the helper will warn you that the command then contains
the secret.

The generated policy always uses your current origin, so a local build suggests
`http://localhost:5173` and a deployed one suggests your real hostname.

**MinIO is different, and Galiot tells you so.** MinIO has no per-bucket CORS
API — `PutBucketCors` answers `501 NotImplemented`, and `mc cors set` fails the
same way — because it configures CORS for the whole server and allows every
origin by default. When Galiot sees that response it stops offering the commands
that cannot work and points at the real setting instead:

```bash
# at server start
MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:5173

# or on a running server (needs admin credentials, then restarts it)
mc admin config set <alias> api cors_allow_origin=http://localhost:5173
mc admin service restart <alias>
```

Because MinIO is permissive by default, a "Failed to fetch" there is usually
something else — the wrong port, an `http`/`https` mismatch, or credentials the
bucket rejects — and the connection test says which.

---

## 9. Verifying against a real server

```bash
./scripts/minio-test.sh
```

That starts MinIO in a container, creates the buckets, runs both live suites
against it and removes it again. It needs Docker (colima or Docker Desktop) and
pulls `quay.io/minio/minio` and `quay.io/minio/mc` — MinIO no longer publishes to
Docker Hub.

- `bun run test:integrity` — uploads round-trip byte-for-byte, multipart ETags are
  recomputed and compared with the bucket's own, interrupted uploads resume,
  range requests return exactly the requested slice, and the checker is proved
  non-vacuous by corrupting a byte.
- `bun run test:minio` — CORS handling, presigned links, listing past the
  1000-key page boundary, keys with spaces and non-ASCII text, and multi-delete.

Worth knowing why the second suite exists: the unit tests and every mock missed
four real defects that a live server caught immediately — an empty
`continuation-token` that MinIO rejects (which made *every* listing fail there), a
double-encoded canonical URI that broke *every* key containing a space or a
non-ASCII character, a missing `Content-MD5` that broke multi-delete, and an
error-code loss that reported a `501` as a permissions problem. Details in
`docs/STACK_DECISION.md` §15.

---

## 10. Optional local companion

A browser cannot fix a bucket's CORS policy: the request that would write it is
itself blocked by the missing policy. That is why a browser *worker* cannot do
it either — CORS is enforced per request, not per thread.

The bridge is a local companion server for two cases: applying a bucket CORS
policy and routing S3 traffic when a gateway cannot answer the browser's
anonymous preflight. The browser still preflights the local companion, which
answers that request; the companion calls S3 outside the browser.

On a deployed Galiot page, open **Connections → Local companion → Download companion** and choose
macOS Apple Silicon, macOS Intel, Windows x64, or Linux x64. Extract the ZIP on
the computer that can reach the S3 gateway. Run the executable from a terminal
with the exact origin shown in the companion panel. For example:

```bash
GALIOT_BRIDGE_ORIGINS=https://galiot.example.com ./galiot-bridge
```

In Windows PowerShell, use
`$env:GALIOT_BRIDGE_ORIGINS='https://galiot.example.com'; .\galiot-bridge.exe`.
The executable prints a one-time token. Keep it running while using Galiot.
The download is a standalone program; users do not need Bun or the
source checkout. [Bun single-file executables](https://bun.sh/docs/bundler/executables).

Developers can also run `bun run bridge`, compile for their own machine with
`bun run bridge:compile`, or generate the downloadable packages with
`bun run bridge:package`. `bun run build` includes the packages in the site.
Each ZIP is split into static parts under 20 MiB and reassembled by the browser
when downloaded, staying below [Cloudflare's 25 MiB per-asset limit](https://developers.cloudflare.com/workers/platform/limits/#static-assets).

For normal file operations, click **Enable companion** in the panel above the
connection list and paste the printed token once. Every connection in this tab,
including ones added later, uses the same companion until the vault locks, the
tab closes, or you disable it. The companion must keep running.
For CORS policy setup, the existing **CORS helper → Apply CORS policy via bridge**
action also uses it. Galiot signs in a worker; raw S3 secret keys never go to
the companion. The companion:

- binds `127.0.0.1` only
- accepts local app origins (`localhost` / `127.0.0.1` on :5173 and :4173) by default
- requires the token it prints at startup
- forwards only requests carrying a SigV4 `Authorization` header
- refuses wildcard origins and non-http(s) targets
- stops entirely with Ctrl+C

Serving Galiot from another origin, including the deployed app, needs that exact
origin allowed. The companion panel shows the command for the current page.
For example:

```bash
GALIOT_BRIDGE_ORIGINS=https://galiot.example.com bun run bridge
```

The companion needs the browser's local network permission where supported.
File operations for every connection use the companion while enabled; generated presigned share links
still target S3 directly, so recipients need a reachable gateway. [Browser CORS
and opaque response behavior](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch),
[local network access](https://developer.chrome.com/blog/local-network-access).

---

## 11. Known Limitations

| Area | Limitation | Why |
|---|---|---|
| Upload resume after reload | You must re-pick the file, then the transfer continues from the recorded upload id and part list | Browsers cannot retain `File` handles across a reload |
| Dual-pane local mode | Read-only listing (upload works, saving downloads locally does not) in browsers without the File System Access API | `showDirectoryPicker` is Chromium-only today; the app falls back to `webkitdirectory` |
| Presigned links | Cannot be revoked once issued | A presigned URL is a self-contained bearer token; only rotating the signing key invalidates it |
| Storage persistence | Safari may evict IndexedDB data after 7 days without user interaction | Platform storage policy; an installed PWA is exempt |
| Folder sizes | Exact only for folders you have visited or scanned with "Exact size" | The cache is populated by browsing; uncached branches are not included |
| Recovering from a lost vault | Impossible without a passphrase or an exported backup | By design: Galiot cannot read its own vault. Export a backup from Vault settings |
| Transfer checksums | Verified on demand, not continuously | ETags are content MD5s only for single-part, unencrypted uploads; multipart ETags are composite |
