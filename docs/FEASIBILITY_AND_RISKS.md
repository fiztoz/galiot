# Galiot — Browser Feasibility, Runtime Constraints & Risk Register

> **Status:** Research pass 3 — constraints the existing specs assume away.
> **Date:** 2026-09-18
> **Method:** Live-source verification (vendor docs, npm registry, GitHub API) of every claim
> below. Nothing here is inferred from memory. Original specs are **not** edited retroactively;
> this document is the correction layer, consistent with `docs/STACK_DECISION.md` §6.
> Related: [`STACK_DECISION.md`](STACK_DECISION.md) (stack pins), [`PGLITE_SPEC.md`](../PGLITE_SPEC.md),
> [`SECURITY_DEEP_DIVE.md`](../SECURITY_DEEP_DIVE.md), [`../IMPLEMENTATION_ROADMAP.md`](../IMPLEMENTATION_ROADMAP.md).

---

## 0. Why this document exists

The stack research answered *"which library do we use?"*. It did not answer *"does the browser
actually let us do this?"*. Four load-bearing assumptions in the current specs are either
outdated or wrong:

1. **"Genuine PostgreSQL 16"** — PGlite has been on **PostgreSQL 18.3** since 2026-06-01.
2. **"PGlite persists to OPFS"** — the recommended browser VFS is **IndexedDB**, and it is a
   *memory-resident* filesystem, not a disk-backed one. This is the biggest architectural
   consequence in this document (§3.1).
3. **"Local-first vault in PGlite"** — Safari/iOS **deletes IndexedDB after 7 days of no user
   interaction** unless the app is installed as a Home Screen Web App (§3.2).
4. **"Streamed multipart uploads, no gigabytes in RAM"** — browser S3 uploads cannot stream a
   body to S3; they are **part-buffered** (§3.4).

---

## 1. Verified corrections to existing docs

| Claim in repo | Verified reality (2026-09-18) | Where to fix |
|---|---|---|
| "PostgreSQL 16 compiled to WASM" (README §1.2, ARCHITECTURE §2, PGLITE_SPEC §1, TECH_STACK §3) | **PostgreSQL 18.3.** PGlite commit `PGlite on Postgres 18.3` (#984) merged 2026-06-01; `postgres-pglite` default branch is `REL_18_3-pglite` (pushed 2026-08-25, latest tag `REL_18_3`) | All four docs; PGLITE_SPEC schema/CTE examples are unaffected |
| PGlite core **0.5.7** (STACK_DECISION §4, §8, §10) | **0.5.8** (published 2026-08-26). Companions: `pglite-react` 0.4.8, `pglite-pgvector` 0.0.9, `pglite-sync` 0.6.9 | STACK_DECISION §11 (added) |
| CodeMirror view 6.43.9 / TanStack Virtual 3.14.10 (§10) | 6.43.12 / 3.14.13. React 19.3.0, Vite 8.3.0, Tailwind 4.3.3, `@codemirror/merge` 6.12.2, Bun 1.4.2 all confirmed | minor pin bump only |
| `@xenova/transformers` for local embeddings (PGLITE_SPEC §4.3) | **Stale package.** `@xenova/transformers` last release 2.17.2; the maintained line is **`@huggingface/transformers` 4.3.0** | PGLITE_SPEC §4.3 should name the new package |
| `aws4fetch` 1.0.20 unmaintained (STACK_DECISION §5) | **Confirmed still 1.0.20** — no release since Aug 2024 (~2 yrs). Vendoring decision stands and is now stronger | no change |
| relaxedDurability gate "fix still open" (STACK_DECISION §4) | **Confirmed still open, 2 months later:** PR #1063 *"fix: don't lose persistence silently under relaxedDurability"* opened 2026-07-20 (open); issue #1065 *"[BUG]: PGlite suppresses synchronization while inside a transaction"* (open); PR #1066 (open). Second bug is directly relevant because transfers/the ledger wrap writes in transactions | gate stands |
| "GitHub Pages cannot set headers" (§6) | Confirmed: community discussion **#199121 is still open**; only workaround remains `<meta>` | no change |

---

## 2. Browser capability matrix (what each target can actually do)

Verified against MDN browser-compat-data (current) and PGlite's own platform tables.

| Capability | Chrome/Edge | Firefox | Safari (desktop) | iOS Safari |
|---|---|---|---|---|
| PGlite In-Memory FS | ✓ | ✓ | ✓ | ✓ |
| PGlite **IndexedDB** FS | ✓ | ✓ | ✓ | ✓ |
| PGlite **OPFS-AHP** FS | ✓ | ✓ | ✗ (252 sync-handle cap vs 300+ Postgres files) | ✗ |
| OPFS (`navigator.storage.getDirectory`) | ✓ | ✓ | ✓ | **✓** (since iOS 15.2; but PGlite OPFS-AHP blocked by 252-handle cap) |
| `FileSystemSyncAccessHandle` (worker-only) | ✓ | ✓ | ✓ | ✗ |
| `showDirectoryPicker()` (dual-pane local folder) | ✓ | **✗** | **✗** |  |
| `FileSystemHandle.requestPermission/queryPermission` (persistent grants) | ✓ |  | ✗ |  |
| `navigator.storage.persist()` | ✓ | ✓ | ✓ (but see §3.2) | ✓ (but see §3.2) |
| PWA / Home Screen install | ✓ | ✓ | — | ✓ |

**Consequences**

- **Dual-pane local mode is Chromium-only in both directions** (picker *and* persistent grants).
  Firefox/Safari degrade to `<input type="file" webkitdirectory>` (read-only listing) — already
  noted in STACK_DECISION §10 item 8, now confirmed at the API level.
- **iPad/iPhone have OPFS but PGlite cannot use it (252-handle cap) and have no FSA**: no local pane, and PGlite must run on the IDB VFS
  (memory-resident). Galiot on iOS is a *remote-only, bounded-catalog* client.

---

## 3. Runtime constraints absent from the current specs

### 3.1 PGlite's recommended browser VFS is memory-resident — catalog size has a hard ceiling

PGlite's own docs on the IndexedDB FS (verbatim):

> "It's a layer over the in-memory filesystem, **loading all files for the database into memory
> on start**, and flushing them to IndexedDB after each query if they have changed. ... storing
> whole files (Postgres has a single file per table or index) as blobs in IndexedDB. Flushing
> whole files can take a few milliseconds after each query."

Implications for `PGLITE_SPEC.md`:

- The 500k-object catalog and its GIN trigram index live inside the **WASM heap**, not on disk.
  A 500k-row `objects_cache` plus `gin_trgm_ops` will plausibly cost **hundreds of MB of WASM
  memory**, and the site is a 32-bit address space.
- **Every mutating query re-flushes whole changed table/index files** to IndexedDB as blobs.
  A large `objects_cache` write is therefore O(table size) of IDB I/O, not O(changed rows).
- Only **OPFS-AHP** is a genuinely file-backed VFS (it is built on OPFS access handles with a
  handle pool; you do not get a normal Postgres directory layout). It is **worker-only** and
  **unavailable on Safari and iOS**.

Required design change: **two storage profiles**.

| Profile | Browsers | VFS | Catalog policy |
|---|---|---|---|
| "Full" | Chrome/Edge/Firefox | `opfs-ahp://` inside a worker | Large / multi-bucket cache; indexes rebuilt lazily |
| "Bounded" | Safari, iOS, OPFS-blocked | `idb://` | Cap rows (suggest ≤ ~50k per bucket), evict by LRU, keep full-fidelity only for the active prefix |

Also note: `PGLITE_SPEC.md` §1/§2 diagrams *"Direct POSIX Sync I/O → OPFS"* as the default. That
path exists only in the Full profile.

### 3.2 Safari/iOS will silently delete the vault after 7 days of inactivity

WebKit's ITP policy, verbatim:

> "ITP deletes all cookies created in JavaScript and **all other script-writeable storage after
> 7 days of no user interaction** with the website. The latter storage forms are: **IndexedDB**,
> LocalStorage, Media keys, SessionStorage, Service Worker registrations and cache."

The only exemption WebKit documents is an **installed Home Screen Web App**:

> "The first-party domain of home screen web applications is exempt from ITP's 7-day cap ...
> In addition, the website data of home screen web applications is kept isolated from Safari."

And `navigator.storage.persist()` is **not** documented to override the 7-day cap — WebKit's
storage-policy post only says persistent origins are *"excluded from eviction"* (the
disk-pressure path), while the 7-day cap is a separate ITP algorithm. Treat persist() as
necessary-but-not-sufficient.

Consequences:

1. **PWA install must move from "polish" to a Phase 1 requirement**: web app manifest,
   `display: standalone`, service worker, and an in-app "Install to make your vault durable"
   path on Safari/iOS. `IMPLEMENTATION_ROADMAP.md` currently has zero PWA/manifest/SW work.
2. The zero-knowledge vault needs an **export/import backup** ("vault recovery file") so a wipe
   is recoverable rather than catastrophic. `SECURITY_DEEP_DIVE.md` §8 has no such item.
3. The object cache and transfer ledger must be treated as **disposable**, and re-hydrated from
   S3 on demand. Cache loss must never equal credential loss.
4. Any copy that claims durability must be browser- and install-state-conditional in the UI.

### 3.3 Storage quota (for capacity planning, not correctness)

- Safari 17+/iOS 17+: **origin quota up to 60% of disk**, overall quota up to 80% (browser app);
  15%/20% for non-browser apps. No user prompt.
- Cross-origin iframes get 10% of the main frame's origin quota (relevant if Galiot is ever
  embedded).
- Chrome/Firefox use their own heuristics and expose the numbers via
  `navigator.storage.estimate()` — Galiot should display this in the connection/settings UI.

### 3.4 S3 uploads cannot be streamed from the browser — the engine is part-buffered

Verified facts:

- `fetch` with a `ReadableStream` body requires **`duplex: 'half'`**, **always triggers a CORS
  preflight**, sends **no `Content-Length`**, and needs HTTP/2. Safari supports streams in
  `Request` but not this mode; feature detection must use the canonical
  `supportsRequestStreams` probe (getter on `duplex`, then check `Content-Type`).
- S3 `UploadPart` requires a known length; S3 does not accept an unsized chunked body for parts.

Therefore: **streaming a file from the File System Access API straight into S3 is not possible.**
The realistic engine reads each part into a `Blob`/`ArrayBuffer` (5 MB minimum, 10,000-part cap
per upload; AWS's own example is 100 MB parts × 1,000 for 100 GB) and issues one signed PUT per
part. "Without buffering entire gigabytes in RAM" (ARCHITECTURE §3.2) is true **per part**, not
per file — the part size *is* the memory bound, so part size becomes a memory-vs-throughput knob
(8–64 MB in the roadmap is reasonable; budget ~4× part size per concurrent part).

### 3.5 SigV4: use `UNSIGNED-PAYLOAD` and get integrity from S3 checksums

AWS documents the *unsigned payload option* explicitly: the literal string `UNSIGNED-PAYLOAD` is
placed in the canonical request and in the `x-amz-content-sha256` header. This removes the need
to read every part twice (once to SHA-256 it, once to send it) — a real win for multi-GB uploads
on battery devices.

Cost of that choice: no transport integrity check from the signature. Compensate on the S3 side:

- `CreateMultipartUpload` + `UploadPart`: `x-amz-checksum-algorithm` / `x-amz-checksum-<algo>`
  headers. **Composite** algorithms (CRC32/CRC32C/SHA-1/SHA-256/XXH*) require every part checksum
  in `CompleteMultipartUpload`; **CRC64NVME** is full-object and needs `x-amz-crc64`.
- Note `crypto.subtle` has **no CRC32/CRC64**, so a small vendored CRC implementation is needed in
  the transfer worker if we adopt S3-native checksums (and this is also what makes AWS's newer
  default-integrity behaviour work).

### 3.6 Listing cost is linear in object count, not "instant"

`ListObjectsV2` returns **at most 1,000 keys per request**. A 500k-object bucket is **~500
sequential requests**; on a 100 ms RTT link with 8-way concurrency that is ~7–15 s of pure API
time *before* indexing, and it is billable per 1,000 requests. This does not invalidate the
PGlite design, but it does mean:

- The catalog is a **cache with warm-up cost**, so it must be incremental and pausable, with
  progress surfaced (the roadmap's "instant" language is aspirational).
- Recursive prefix math (delimiter-free listing per prefix) must be budgeted as N requests per
  folder, not one.
- Consider `S3 Inventory` / `ListObjectsV2` delimiters per prefix to avoid full-bucket scans.

### 3.7 Multi-tab: one PGlite, elected leader, and no background transfers

Verified API: `PGliteWorker` runs a leader election across tabs sharing an `id`; only the leader
starts PGlite and serves all queries; on leader close a new election runs and a **new PGlite
instance is started** (`isLeader`, `onLeaderChange(cb)` / `offLeaderChange(cb)` exposed).

Consequences:

- With the IDB VFS, every leader handover re-reads the **entire database into memory** (§3.1).
  Closing the last Galiot tab and reopening it is a cold start, not a reattach.
- Transfers cannot continue after the tab closes (STACK_DECISION §6 item 5 already corrected the
  "survives tab close" overclaim). The ledger must be written before the tab can die — i.e. new
  tabs resume from `transfer_parts`, they do not adopt in-flight requests.
- Multi-tab + OPFS-AHP is the supported combination; multi-tab + IDB is functionally correct but
  pays a reload on every handover.

---

## 4. Internal inconsistencies in the existing doc set

These are drift, not new facts, but a first-time reader of `README.md` gets the older story.

| Topic | Older docs say | Correct decision doc says |
|---|---|---|
| Editor | Monaco (README §3, ARCHITECTURE §3.4, TECH_STACK §4.2, PGLITE_SPEC §5, ROADMAP 4.1, parity matrix) | CodeMirror 6 (STACK_DECISION §3) |
| Default PGlite storage | OPFS (README §1.2, ARCHITECTURE §2, TECH_STACK §3, PGLITE_SPEC §1) | IndexedDB VFS first, OPFS-AHP progressive (STACK_DECISION §4) + §3.1 above |
| Postgres version | 16 | 18.3 (§1) |
| Clickjacking | `frame-ancestors 'none'` in meta CSP "prevents clickjacking" (SECURITY §3.1) | meta CSP ignores `frame-ancestors` (STACK_DECISION §6 item 4) |
| Workers | "content scripts cannot inject into Web Workers" ⇒ XSS boundary (SECURITY §4.2) | Not an XSS boundary (STACK_DECISION §6 item 1) |
| PBKDF2 rounds | 100,000+ (ARCHITECTURE §3.3) | 600,000 (SECURITY §2.1, STACK_DECISION §7) |
| PRF | "hardware-backed security equivalent to macOS Keychain" (SECURITY §2.2) | PRF can be software-backed; enhancement only (STACK_DECISION §6 item 3, §7) |

**Recommendation:** `README.md` is the front door and currently answers questions with the
superseded answers. Add a one-line "superseded by STACK_DECISION §N" banner per topic there
rather than rewriting the specs.

---

## 5. Governance / repo gaps vs the Galeon sibling

`galeon/` (the desktop sibling) carries `AGENTS.md`, `DESIGN.md` (Stitch-style semantic tokens),
`docs/DIRECTION.md`, `docs/ROADMAP.md`, `LICENSE`, `SECURITY.md`, `.github/workflows`, and a git
repo. `galiot/` currently has **nine markdown files and no git repository**. Before Phase 1 code
lands, Galiot should pick up:

- `AGENTS.md` (agent/contributor conventions), `LICENSE`, `docs/DIRECTION.md` (product intent,
  non-goals), `DESIGN.md` (reuse Galeon's Zinc + Gale Teal `#0d9488` + Doubloon Amber `#d97706`).
- A git repo + CI skeleton (build, `bun audit`, SQL/signing tests) since the roadmap's 1.1 assumes
  GitHub Actions deployment already exists.

---

## 6. Updated Phase 1 spike list

Replaces/extends `STACK_DECISION.md` §9. Each is timeboxed and must produce a written result.

1. **Bun-bundler spike** (0.5d) — unchanged: CodeMirror + PGlite wasm + one `?worker`.
2. **PGlite durability + VFS matrix** (1.5d, was 1d) — now must measure, per browser:
   cold start and first-query latency at 10k / 50k / 100k rows on `idb://` **and** `opfs-ahp://`,
   heap growth, and per-write flush cost. Confirm `relaxedDurability` still unsafe (§1) by
   asserting no data loss on abrupt reload.
3. **Safari/iOS storage durability** (1d, **new**) — reproduce the ITP 7-day wipe, verify the
   Home Screen Web App exemption, and prove the vault export/restore path.
4. **Transfer engine memory profile** (1d, **new**) — part-buffered upload at 8/16/64 MB parts,
   `UNSIGNED-PAYLOAD` signing, memory ceiling, resume after forced tab kill.
5. **aws4fetch signing parity** (0.5d) — unchanged; add an `UNSIGNED-PAYLOAD` vector and the
   CRC32C/CRC64NVME checksum headers.
6. **PRF capability probe** (0.5d) — unchanged; use `getClientCapabilities()`, never UA sniffing.
7. **Multi-tab leader handover** (0.5d, **new**) — `PGliteWorker` kill-the-leader test; confirm
   ledger-driven resume and measure IDB reload cost on handover.

---

## 7. Sources

**Corrected facts**
- PGlite on Postgres 18.3 — https://github.com/electric-sql/pglite (commit "PGlite on Postgres 18.3", #984, 2026-06-01) and https://github.com/electric-sql/postgres-pglite (`REL_18_3-pglite`, tag `REL_18_3`)
- PGlite filesystems (IDB is memory-resident; OPFS-AHP platform table; Safari 252-handle cap) — https://pglite.dev/docs/filesystems
- PGlite multi-tab worker (leader election, `isLeader`, `onLeaderChange`) — https://pglite.dev/docs/multi-tab-worker
- PGlite relaxedDurability fixes still open — https://github.com/electric-sql/pglite/pull/1063, /issues/1065, /pull/1066
- npm registry (versions, 2026-09-18): `@electric-sql/pglite` 0.5.8, `pglite-react` 0.4.8, `pglite-pgvector` 0.0.9, `pglite-sync` 0.6.9, `aws4fetch` 1.0.20, `@huggingface/transformers` 4.3.0, `@xenova/transformers` 2.17.2, `react` 19.3.0, `vite` 8.3.0, `tailwindcss` 4.3.3, `@codemirror/view` 6.43.12, `@codemirror/merge` 6.12.2, `@tanstack/react-virtual` 3.14.13, `bun` 1.4.2
- Bun releases — https://github.com/oven-sh/bun/releases (1.4.0 2026-08-20, 1.4.2 2026-09-05)

**Browser capabilities / storage policy**
- WebKit ITP, 7-day cap on script-writable storage + Home Screen Web App exemption — https://webkit.org/tracking-prevention/
- WebKit storage policy (quotas, persistent mode exempt from *eviction*) — https://webkit.org/blog/14403/updates-to-storage-policy/
- MDN browser-compat-data: `Window.showDirectoryPicker`, `FileSystemHandle.requestPermission`, `StorageManager.getDirectory/persist`, `FileSystemSyncAccessHandle` (Chromium-only vs Firefox/Safari/iOS split, 2026-09-18)
- MDN `StorageManager.persist()` — https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist

**S3 / signing / fetch**
- Streaming fetch requests (`duplex:'half'`, mandatory preflight, no Content-Length) — https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests
- SigV4 unsigned payload option / `x-amz-content-sha256` — https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
- Multipart upload (part sizing, 10,000-part cap, checksum matrix, incomplete-part billing) — https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html
- `ListObjectsV2` returns up to 1,000 keys — https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html

**Hosting**
- GitHub Pages limits (1 GB site, 100 GB/mo soft bandwidth, 10 builds/h, commercial-use terms) — https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- Custom headers still unsupported — https://github.com/orgs/community/discussions/199121

---

*End of feasibility note. Update when a spike closes; add new rows rather than rewriting history.*