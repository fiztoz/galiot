# Galiot — The Agile Cloud Explorer

> *A self-hosted cloud & object storage web client inspired by **Galeon**, powered by **PGlite** (WASM Postgres) and **Bun**. The server signs and calls S3. You run it on a machine that can reach the bucket. It is not a Cloudflare or Vercel app.*

---

## 1. Executive Summary

**Galeon** is a fast, lightweight desktop client for S3, SFTP, and remote storage built with Tauri v2 and Rust.

**Galiot** is its agile, web-native cousin. Where Galeon serves as the heavy native desktop flagship (with direct access to the OS keychain and local binaries), Galiot brings that same high-performance, keyboard-first, and zero-telemetry experience **directly into any web browser**.

### The Core Architectural Pillars:
1. **Self-hosted server, local vault**: You run Galiot. The Bun server signs each S3 request and opens the connection. Credentials are sealed in the browser vault and sent to your own server for the session only. It is not a Cloudflare Worker or a Vercel function.
2. **PGlite WASM Engine**: Runs genuine PostgreSQL 18.3 compiled to WebAssembly inside a browser Web Worker, persisting data locally to the browser's **Origin Private File System (OPFS)**.
3. **The host must reach S3**: listing, transfer, edit, and preview all go through the server. The visitor's browser does not need a route to the bucket, and the bucket does not need CORS for those operations. A private MinIO or on-premises gateway works when the Galiot host can reach it.
4. **HTML5 Dual-Pane Local Explorer**: Mounts local computer directories using the **File System Access API** (`window.showDirectoryPicker()`).
5. **In-Browser CodeMirror 6 Editor**: Edit remote files with real language support, review a side-by-side diff, then save straight back to the bucket. Images, PDFs, audio and video preview natively.
6. **Bun 1.4 Toolchain**: Developed and bundled with Bun 1.4 for sub-second builds and instant static packaging.

---

## 2. High-Level Architecture

```
+───────────────────────────────────────────────────────────────────────────+
|                           GALIOT ARCHITECTURE                             |
| (Bun server + static bundle — host the process anywhere)                |
+───────────────────────────────────────────────────────────────────────────+
|                                                                           |
| App server (Bun, any host that can reach S3 — not a platform function) |
|   ├── Serves the static bundle: index.html + JS + CSS + pglite.wasm       |
|   └── /api/s3 signs requests and calls the bucket on this host's network  |
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
|   │   ├── Holds the DEK (15-min idle auto-lock) and opens a server session |
|   │   └── Gives the transfer worker a session id, never the secret         |
|   │                                                                       |
|   ├── Transfer Worker (Web Worker)                                         |
|   │   ├── Parallel multipart uploads with pause/resume + part ledger      |
|   │   └── Range-based resumable downloads into OPFS or a local folder     |
|   │                                                                       |
|   └── UI (main thread)                                                     |
|       ├── Virtualized list/grid explorer: multi-select, lasso, filters    |
|       ├── CodeMirror 6 editor + diff, media previews, presigned links     |
|       └── S3 operations go to /api/s3 on this origin. The page does not   |
|           open its own connection to the bucket.                          |
|                                                                           |
+───────────────────────────────────────────────────────────────────────────+
```

Run it with Bun. Development includes the proxy. Production serves `dist/` and the same proxy:

```bash
bun install
bun run dev          # http://127.0.0.1:5173, proxy included
bun run build && bun run server
```

A public bind refuses to start unless `GALIOT_PROXY_TOKEN` or `GALIOT_GATE` is set (or you explicitly set `GALIOT_PROXY_OPEN=1`). The gate is not an S3 key.

Rename, move, copy and new folders run inside S3 (`CopyObject`, multipart
`UploadPartCopy` above 5 GiB) — the bytes never pass through the browser. Share
links default to a short-lived URL that streams from this server, so they work
for people who cannot reach S3 and can be revoked here; upload links work the
same way with a byte cap and a single fixed key. Presigned S3 links remain
available as an explicit option; they use the recipient's network and cannot
be revoked. See [docs/OPERATIONS.md](docs/OPERATIONS.md).

On versioned buckets, Details lists every version with download, restore
(server-side copy onto the key), and permanent purge. Search can walk the whole
bucket on the server, not just the cached folder. Connections can be shared as
secret-free JSON ("Share connection" / "Import connection"); moving keys stays
with the ciphertext-only vault backup under its passphrase.

Folders upload with their structure (picker or drag & drop, capped at 2000
files per drop), mirroring folder downloads. Archived objects show a snowflake
and can be restored from Details; object-lock retention and legal hold are
shown there and checked before single-object delete, rename, or copy-over.

---

## 3. Documentation Index

The complete research and technical specification suite for Galiot:

| Document | Description |
|---|---|
| [**docs/OPERATIONS.md**](docs/OPERATIONS.md) | Operator guide: running the server (Bun, container, Kubernetes via `deploy/helm/galiot`), host reachability, the access gate, where credentials live, and which network each feature uses. |
| [**docs/STACK_DECISION.md**](docs/STACK_DECISION.md) | Verified stack comparison with sources, provisional decisions, and corrections to earlier specs (2026-09-17; pass 3 2026-09-18). |
| [**docs/FEASIBILITY_AND_RISKS.md**](docs/FEASIBILITY_AND_RISKS.md) | Browser feasibility pass: Postgres 18.3, memory-resident IDB VFS, Safari 7-day storage deletion, part-buffered S3 uploads, and the revised Phase 1 spike list (2026-09-18). |
| [**SECURITY_DEEP_DIVE.md**](SECURITY_DEEP_DIVE.md) | Comprehensive security threat model: WebCrypto vault, memory zeroing, CSP, browser extension defense, and untrusted file sandboxing. Historical spec — its "Current security model (2026-11)" correction covers the self-hosted server that now signs and calls S3. |
| [**ARCHITECTURE.md**](ARCHITECTURE.md) | Original architectural blueprint (client-only PWA era). Its hosting and CORS model is superseded — see the correction banner at its top and STACK_DECISION §22. |
| [**PGLITE_SPEC.md**](PGLITE_SPEC.md) | Complete WASM Postgres blueprint: schema, OPFS storage worker, live reactive queries, CTEs, and vector search. |
| [**TECH_STACK.md**](TECH_STACK.md) | Original stack deep dive (Bun 1.4, React 19, Tailwind v4, editor choice, browser storage APIs). Its editor choice was superseded — see STACK_DECISION §3. |
| [**GALEON_PARITY_MATRIX.md**](GALEON_PARITY_MATRIX.md) | Feature-by-feature parity analysis comparing Galeon (Desktop) with Galiot (Web). |
| [**IMPLEMENTATION_ROADMAP.md**](IMPLEMENTATION_ROADMAP.md) | Phased engineering implementation roadmap from Phase 1 to production launch. |
| [**NAMING_CANDIDATES.md**](NAMING_CANDIDATES.md) | Archive of the naming evaluation and brand decision history. |
| [**benchmarks/ENGINE.md**](benchmarks/ENGINE.md) | Measured engine performance: listing, search, filters and roll-up latency at 10k/100k objects. |

---

## 4. Comparison: Galeon vs. Galiot

| Dimension | Galeon (Desktop) | Galiot (Web) |
|---|---|---|
| **Form Factor** | Desktop App (.dmg, .exe, .deb) | Web app plus a small server |
| **Hosting** | N/A (Local Install) | Any host that can run Bun or the container |
| **Core Runtime** | Tauri v2 + Rust + tokio | Browser (V8/JSC) + WebAssembly |
| **Build Toolchain** | Bun + Cargo | **Bun 1.4** + Vite |
| **Catalog Database** | In-memory HashMap / JSON | **PGlite (WASM Postgres in OPFS)** |
| **Query Engine** | Linear scan | Full PostgreSQL (SQL, CTEs, Indexes) |
| **Credentials** | OS Keyring (macOS Keychain, etc.) | WebCrypto AES-GCM-256 Vault |
| **Local File Access** | Unrestricted `std::fs` | HTML5 File System Access API |
| **File Editing** | Spawns external VS Code binary | Built-in CodeMirror 6 with side-by-side diff |
| **S3 Protocol** | Direct TCP via OpenDAL | Signed HTTPS via the app server |
| **Telemetry / Tracking**| Zero (Privacy first) | Zero (no analytics; traffic goes only to your own server and S3) |

---

## 5. Importing connections from Galeon

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

## 6. Editing a connection

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

## 7. Fixing CORS from a terminal, with nothing pre-configured

The app itself does not need bucket CORS. Listing, transfer, edit, and preview
go through the Galiot server. This section is only for a share link or other
direct browser load of the bucket.

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

## 8. Verifying against a real server

The primary live suite runs Zenko CloudServer in a container
(`./scripts/live-s3-test.sh`; see [docs/OPERATIONS.md](docs/OPERATIONS.md) §7).
`./scripts/minio-test.sh` remains for operators with cached MinIO images:

```bash
./scripts/minio-test.sh
```

That starts MinIO in a container, creates the buckets, runs both live suites
against it and removes it again. It needs Docker (colima or Docker Desktop) and
cached `quay.io/minio/minio` and `quay.io/minio/mc` images — MinIO images are no
longer publicly pullable (upstream archived 2026-04-25).

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

## 9. Where S3 traffic goes

Every S3 request is posted to `/api/s3` on the Galiot origin. The Bun server
signs it and calls S3, so the bucket does not need a CORS policy for listing,
upload, download, edit, or preview. The machine running Galiot has to be able
to reach the endpoint. A bucket that is only visible on a laptop VPN stays
unreachable until that machine can see it too.

Only "Direct S3" presigned share links open the object URL in a browser. Those
loads use the viewer's network and can need a bucket CORS rule; in-app
previews stream through this server over a same-origin media URL and do not.

---

## 10. Known Limitations

| Area | Limitation | Why |
|---|---|---|
| Upload resume after reload | You must re-pick the file, then the transfer continues from the recorded upload id and part list | Browsers cannot retain `File` handles across a reload |
| Dual-pane local mode | Read-only listing (upload works, saving downloads locally does not) in browsers without the File System Access API | `showDirectoryPicker` is Chromium-only today; the app falls back to `webkitdirectory` |
| Presigned links | Cannot be revoked once issued | A presigned URL is a self-contained bearer token; only rotating the signing key invalidates it |
| Storage persistence | Safari may evict IndexedDB data after 7 days without user interaction | Platform storage policy; an installed PWA is exempt |
| Folder sizes | Exact only for folders you have visited or scanned with "Exact size" | The cache is populated by browsing; uncached branches are not included |
| Recovering from a lost vault | Impossible without a passphrase or an exported backup | By design: Galiot cannot read its own vault. Export a backup from Vault settings |
| Transfer checksums | Verified on demand, not continuously | ETags are content MD5s only for single-part, unencrypted uploads; multipart ETags are composite |

---

## 11. Security & contributing

- Report vulnerabilities privately — see [SECURITY.md](SECURITY.md). The server
  holds session credentials in memory; the vault is zero-knowledge at rest.
- Development setup, checks, and conventions: [CONTRIBUTING.md](CONTRIBUTING.md).

## 12. License

[MIT](LICENSE) © Galiot Contributors. Self-host it, fork it, ship it.
