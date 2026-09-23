# Galiot — Stack Decision & Technology Comparison

> **Status:** Research complete; decisions provisional until Phase 1 spikes validate them.
> **Date:** 2026-09-17
> **Method:** All claims below verified against official/current sources (linked per section).
> Benchmarks cited are from vendors or public suites and may vary by hardware.

---

## 0. Scope

Galiot is a 100% client-side S3 explorer hosted on GitHub Pages. This document compares
each layer of the proposed stack with the realistic alternatives, records the decision,
and corrects earlier docs where 2026 reality diverges from the original specs.

Layers compared: UI framework, build tooling, code editor, local database,
S3 client, hosting/security constraints.

---

## 1. UI framework — React 19 (KEEP)

**Decision: React 19, SPA-only, no SSR/RSC.**

Pros (verified):
- Ecosystem: ~190M weekly npm downloads; TanStack Virtual, Monaco/CM wrappers,
  `@electric-sql/pglite-react` all target React first.
- React Compiler ships with React 19 and auto-memoizes stable subtrees.
- react.dev officially supports the "build from scratch" Vite SPA path
  (client-only; SSR/RSC only activate via meta-frameworks).

Cons:
- ~45-72KB runtime vs ~5-10KB for alternatives; VDOM re-render model is
  measurably slower than signal-based frameworks on heavy DOM workloads.

Alternatives considered:
| Option | Evidence | Why not |
|---|---|---|
| SolidJS 1.9 | ~7KB runtime; fine-grained signals; top js-framework-benchmark | Ecosystem too small; virtual-table/editor wiring would be hand-rolled |
| Svelte 5 (runes) | ~28KB compiled; compiler-driven reactivity | Smaller ecosystem for virtualized tables; rewrite of all UI plans |
| Preact 10/11 | ~5KB; compat layer | `useSyncExternalStore` (used by pglite-react) and React 19 edge APIs are compat risks |

Rationale: the two performance-critical layers (TanStack Virtual rendering,
PGlite in a worker) bypass VDOM reconciliation anyway, so React's weaknesses
do not bite here, while its ecosystem removes real work.

Sources:
- https://react.dev/learn/build-a-react-app-from-scratch (SPA supported; Vite recommended)
- https://tanstack.com/virtual (v3, React adapter, React 19 note: set useFlushSync:false)
- https://www.pkgpulse.com/guides/solidjs-vs-svelte-5-vs-react-reactivity-2026 (benchmark aggregate)

---

## 2. Build tooling — Bun 1.4 as runner + Vite 8 as bundler (ADJUSTED)

**Decision: keep Bun >= 1.4.2 (package manager, test runner, CI), but default the
production bundle to Vite 8; only fall back to `bun build` if it passes the
spike below.**

Verified findings (2026-09-17 re-check; latest stable is 1.4.2, 2026-09-05):
- Bun 1.4 released 2026-08-20; runtime rewritten Zig -> Rust; adds Bun.cron(),
  bun audit, parallel test/run, Node 26.3 compat. bun.lock/frozen installs OK.
- Vite 8 (current 8.3.x) now bundles with Rolldown (Rust) internally; dev HMR
  remains excellent; plugin ecosystem is the deciding factor.
- rolldown/benchmarks (2026-08-28): bun 1.4 production build ~0.5-0.7s vs
  Vite ~2-3s on a 10k-module app. Bun is genuinely faster when it works.
- Caution: v1.4.1 shipped a `bun build` variable-name-collision regression
  (fixed in 1.4.2). Pin >= 1.4.2 and keep the bundler spike on the pinned
  version. (1.4.1 also improved `bun build` tree-shaking substantially,
  e.g. zod -79%, which helps the Bun-bundler case if the spike passes.)

Why Vite stays default anyway:
- Monaco (if kept) and PGlite need worker bundling + wasm asset emission
  (`?worker` imports, `new Worker(new URL(...))`, wasm file copying).
  Vite has first-class plugins for all of these; Bun's bundler support for
  Monaco worker graphs is unproven as of 2026-09.
- Vite officially targets Baseline Widely Available browsers and handles
  `base` paths for GitHub Pages project sites (mandatory for /galiot/ URLs).

Spike to run in Phase 1 (timebox 0.5 day):
1. `bun build` with: Monaco OR CodeMirror, PGlite wasm asset, one `?worker` file.
2. Accept Bun bundler only if zero custom plugins are needed.
3. Otherwise: Vite 8, executed by Bun (`bun run build` -> `vite build`).

Alternatives considered:
| Option | Evidence | Why not |
|---|---|---|
| Rspack 2 / Rsbuild | webpack-compatible, Rust-fast | Webpack compat irrelevant for greenfield |
| Turbopack | fastest HMR | Next.js-only; excludes plain SPA |
| Rollup direct | reference quality | 77-83x slower builds than Bun in same benchmark |

Sources:
- https://bun.com/blog/bun-v1.4 (Rust rewrite, features, dates)
- https://bun.sh/blog/bun-in-rust (rewrite details)
- https://github.com/rolldown/benchmarks (bun vs vite vs rspack, 2026-08-28)
- https://vite.dev/guide/ (Vite 8, Rolldown, browser targets)
- https://react.dev/learn/build-a-react-app-from-scratch (Vite/Parcel/Rsbuild as SPA tools)

---

## 3. Code editor — CodeMirror 6 replaces Monaco (CHANGED)

**Decision: CodeMirror 6 for the built-in editor and diff viewer.**

This reverses the original TECH_STACK.md / ARCHITECTURE.md choice of Monaco.
Verified evidence:

| Dimension | Monaco | CodeMirror 6 |
|---|---|---|
| Bundle size | ~1-5MB minified | ~50-200KB tree-shaken (~116KB gz full core) |
| Workers | Required (editor + language services), needs build config | None required |
| Mobile | Official FAQ: "Is the editor supported in mobile browsers? No." | First-class touch support |
| Diff view | Built-in DiffEditor | `@codemirror/merge` |
| TS IntelliSense | Full built-in LSP | Syntax-level only |
| CSP compatibility | Works, but more moving parts | Plain ES modules, no eval |
| Accessibility | Basic | Excellent (docs + screen-reader support) |

Rationale:
- Galiot's editor is a config/data-file editor (JSON, YAML, TOML, MD, SQL) with
  side-by-side diff before re-upload - not an IDE. Monaco's one decisive
  advantage (TypeScript language service) is irrelevant for that use case.
- 90% smaller editor payload matters on a zero-install web app where first
  load IS the install.
- Azure LogicAppsUX migrated Monaco -> CM6 for exactly these reasons
  (~2MB -> ~150KB, simpler build, equal features for their use case).

Language coverage needed by Galiot (all in CM6 official packages):
JSON, YAML, Markdown, Python, Rust, SQL, XML/HTML, CSS - plus legacy modes
for the rest via @codemirror/legacy-modes.

Escape hatch: if full TS IntelliSense is ever demanded, lazy-load Monaco in a
separate route as an opt-in "IDE mode" (dynamic import keeps it out of the
main bundle).

Sources:
- https://github.com/microsoft/monaco-editor (FAQ: mobile not supported; worker requirements)
- https://codemirror.net/ (feature list, language packages)
- https://www.pkgpulse.com/guides/monaco-editor-vs-codemirror-6-vs-sandpack-in-browser-2026
- https://github.com/Azure/LogicAppsUX/blob/main/docs/plans/2025-01-14-monaco-to-codemirror-design.md
- https://bundlephobia.com/package/codemirror (364KB min / 116KB gz)

---

## 4. Local database — PGlite (KEEP, storage backend corrected)

**Decision: PGlite >= 0.5 (core 0.5.7 as of 2026-08) with the IndexedDB VFS;
OPFS-AHP only as progressive enhancement.**

This corrects PGLITE_SPEC.md / ARCHITECTURE.md, which assumed OPFS sync access
handles as the default.

Verified facts (re-checked 2026-09-17):
- PGlite is real Postgres (16) in WASM, ~3MB gzipped, Apache-2.0/PostgreSQL
  dual-licensed, ~16k GitHub stars, 13M+ weekly downloads, v0.4 (2026-03)
  added PostGIS, connection multiplexing, initdb-as-separate-process.
- Official filesystems doc: "We would recommend using the IndexedDB VFS in the
  browser at the current time as the OPFS VFS is not supported by Safari."
- OPFS-AHP FS is worker-only, and Safari caps open sync access handles at 252
  while a stock Postgres install uses 300+ files -> it cannot work there.
- IDB FS flushes whole files after each query; `relaxedDurability` defers the
  flush asynchronously (recommended for UI responsiveness) - WITH ONE CAVEAT
  (2026-09-17): upstream has an open fix "don't lose persistence silently
  under relaxedDurability" (Jul 2026). Do NOT use relaxedDurability for the
  credential vault or transfer ledger until the pinned version contains that
  fix; verify in the spike. Durable (default) mode is unaffected.
- Companion packages at re-check: @electric-sql/pglite-react 0.4.7,
  @electric-sql/pglite-pgvector 0.0.8, pglite-sync 0.6.8. Watch the draft
  "Worker-backed postmaster" PR - it is the future multi-tab story beyond
  today's single-connection multiplexing.
- Benchmarks (pglite.dev): wa-sqlite is faster purely in memory; PGlite is
  FASTER for single-row CRUD (WAL vs rollback journal); fsync cost dominates
  in browsers. Both are within native-Postgres-vs-SQLite expectations.

| Option | Pros | Cons for Galiot |
|---|---|---|
| PGlite (chosen) | Full SQL: recursive CTEs, trigram GIN, pgvector; live queries; single-connection muxed in 0.4 | ~3MB WASM; IDB flush latency (mitigated by relaxedDurability) |
| SQLite-WASM official | ~1MB; fastest bulk writes in some suites | OPFS VFS requires COOP/COEP headers - NOT settable on GitHub Pages; opfs-sahpool VFS has no multi-tab concurrency |
| Dexie (IDB wrapper) | ~25KB; mature liveQuery; cross-tab sync; zero WASM | No SQL (no CTEs/trigram/vector); would force JS-side folder rollups and search |
| Raw IndexedDB | zero deps | Manual index management; re-implements Dexie badly |

Decision rationale: trigram search, recursive CTE folder rollups, and optional
pgvector are core to the Galiot spec and only PGlite offers them in-browser.
If bundle size becomes a v1 problem, Dexie is the designated fallback for
profiles/transfers while deferring the SQL features.

Schema note: the schema in PGLITE_SPEC.md is valid as written (tested against
v0.4 features: JSONB, TIMESTAMPTZ, BIGSERIAL, gin_trgm_ops all supported).

Sources:
- https://pglite.dev/docs/filesystems (IDB recommended; Safari 252-handle limit)
- https://electric-sql.com/blog/2026/03/25/announcing-pglite-v04 (v0.4 details)
- https://pglite.dev/benchmarks (PGlite vs wa-sqlite numbers)
- https://sqlite.org/wasm/doc/trunk/persistence.md (COOP/COEP requirement for opfs VFS)
- https://dexie.org/docs/liveQuery() (Dexie reactivity model)

---

## 5. S3 client — aws4fetch as signing core (ADJUSTED)

**Decision: `aws4fetch` (2.5KB gz) for SigV4 signing + hand-rolled multipart
orchestrator, instead of the AWS SDK or a from-scratch signer.**

| Option | Size | Multipart | Presigned URLs | R2/MinIO/B2 | Verdict |
|---|---|---|---|---|---|
| Hand-rolled SigV4 | ~0 | manual | manual | full control | Rejected: canonical-request edge cases (virtual hosts, %2F, unsigned payloads) are a bug farm |
| @aws-sdk/client-s3 | hundreds of KB min | lib-storage managed | s3-request-presigner | works, occasional payload-signing quirks | Too heavy for the bundle budget; much of it (waiters, paginators, checksums) unused |
| aws4fetch (chosen) | 2.5KB gz | manual | signQuery built-in | proven (Cloudflare Workers/R2 docs use it) | Only fetch + SubtleCrypto - zero Node polyfills, perfect for browser |

Verified facts (re-checked 2026-09-17):
- aws4fetch: 6.4KB min / 2.5KB gzip; MIT; exports AwsClient + AwsV4Signer;
  supports session tokens, query signing (presigned URLs), retries with
  exponential backoff + full jitter; no Node polyfills needed.
- STALENESS FLAG: last published 1.0.20 in Aug 2024 (~2 years, 159 dependents).
  SigV4 itself is stable so the code still works, but an unmaintained signing
  dependency in a security-critical path is undesirable. Mitigation: VENDOR the
  ~292-line MIT source (`dist/aws4fetch.esm.mjs`) into the repo under
  `src/lib/aws4fetch.ts` (consistent with the existing zero-CDN policy), pin
  the vendored version, and cover it with the signing-vector tests below.
  Alternative `aws-sigv4-fetch` is maintained but drags in @aws-sdk weight -
  keep as fallback only.
- @aws-sdk/client-s3 remains the fallback if managed multipart (`lib-storage`)
  is deemed worth the bundle cost; the S3RequestPresigner internally uses
  SignatureV4MultiRegion and defaults expiresIn to 900s.
- Multipart part size, ETag ledger, and resume logic stay in Galiot's transfer
  engine (transfer_parts table in PGlite) regardless of signer choice - the
  SDK's managed upload would conflict with the custom pause/resume ledger.

Test coverage required (phase 1.4): signing equality against AWS-hosted test
vectors for: path-style vs virtual-host, special chars in keys (spaces, +, %,
unicode), session tokens, unsigned-payload streaming, R2 + MinIO + B2
endpoints.

Sources:
- https://github.com/mhart/aws4fetch (size, API, retry policy)
- https://github.com/aws/aws-sdk-js-v3/tree/main/packages/s3-request-presigner (presigner behavior)
- https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/ (R2 compatibility reference)

---

## 6. Hosting + security constraints (CORRECTED)

**Decision: GitHub Pages for v1 launch; Cloudflare Pages documented as the
escape hatch if header-controlled features are needed.**

> **Superseded 2026-09-18:** the launch host is now **Cloudflare Pages** (free, no card, no
> static-request/bandwidth cap, custom headers). GitHub Pages is demoted to docs mirror.
> Full free-tier comparison for a non-commercial OSS project: [`HOSTING_COMPARISON.md`](HOSTING_COMPARISON.md).

Verified facts (all current as of 2026-09):
- GitHub Pages CANNOT set custom response headers (`_headers`-style config is
  ignored; confirmed by GitHub staff on pages-gem). Consequences:
  - No `Content-Security-Policy` HTTP header; only `<meta http-equiv>` CSP.
  - No COOP/COEP -> no SharedArrayBuffer -> SQLite-WASM `opfs` VFS impossible
    (reinforces section 4: PGlite IDB VFS only on GH Pages).
  - No `Cross-Origin-Opener-Policy`/`Embedder-Policy`, no HSTS preload control,
    no `Permissions-Policy` hardening.
- CSP via `<meta>` works for script-src/style-src/img-src/connect-src etc.,
  but **`frame-ancestors` is IGNORED in meta tags** (spec + MDN). Clickjacking
  protection is therefore unenforceable on GH Pages without a proxy in front.
  Same gap for `report-uri`/`report-to` and `sandbox`.
- `github.io` sits on the Public Suffix List, so `alice.github.io` and
  `bob.github.io` are isolated origins. Risk remains only when the SAME
  `user.github.io` origin hosts multiple apps (a sibling app could read
  Galiot's IDB/OPFS). Documented mitigations: custom domain, or dedicate the
  root user site to Galiot.
- Cloudflare Pages supports full `_headers` config (CSP incl. frame-ancestors,
  COOP/COEP, HSTS, X-Frame-Options, Permissions-Policy). It is the documented
  upgrade path if multi-tab SQLite-WASM or header CSP is ever required.
- S3-side: CORS on the bucket governs ONLY whether the browser will send the
  request; authorization still comes from ACLs/policies. Presigned URLs are
  bearer tokens (up to 7 days for IAM users). The connection wizard must reject
  `AllowedOrigins: ["*"]` (already in SECURITY_DEEP_DIVE.md).

Corrected overclaims in existing docs:
1. "Workers are an XSS boundary" (SECURITY_DEEP_DIVE.md 4.2): FALSE as stated.
   Same-origin script can spawn its own worker; content scripts cannot inject
   INTO an existing worker, but they can wrap fetch/postMessage in the main
   thread. Workers reduce DOM exposure; they are NOT an XSS boundary.
2. "Memory zeroing via buffer.fill(0)" (2.3): treat as defense-in-depth ONLY.
   WebCrypto spec does not require zeroization; JS strings are immutable and
   GC copies are invisible. Keep the practice, remove the guarantee language.
3. "PRF is always hardware-bound" (2.2): PRF CAN be software-backed; support
   is platform-dependent (see section 7). Do not claim Keychain equivalence.
4. "Meta CSP gives frame-ancestors" (3.1): meta CSP does NOT include
   frame-ancestors. Either accept the gap on GH Pages or front with a proxy.
5. "Transfers survive tab close": plain fetch/XHR dies with the tab. Only the
   experimental Background Fetch API (Chromium, SW-gated) survives; plan resume
   via the PGlite ledger on reopen, not background continuation.

Sources:
- https://github.com/github/pages-gem/issues/415 (no custom headers on Pages)
- https://developers.cloudflare.com/pages/configuration/headers/ (CF _headers)
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors (meta unsupported)
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html (CORS is not authz)
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html (bearer, TTL)
- https://sqlite.org/wasm/doc/trunk/persistence.md (COOP/COEP requirement)

---

## 7. Credential vault — WebAuthn PRF optional, passphrase primary (CORRECTED)

**Decision: passphrase-derived vault (PBKDF2-600k or Argon2id-WASM) as the
primary path; WebAuthn PRF as progressive enhancement, never required.**

Verified facts (re-checked 2026-09-17):
- WebAuthn Level 3 became a W3C Recommendation 2026-08-25; the PRF extension
  derives a 32-byte secret from the authenticator during the ceremony.
- Support is fragmented (Yubico compat matrix, unchanged in 2026):
  Chrome/Edge + roaming keys OK; Windows Hello lacks hmac-secret; Apple
  iOS/iPadOS blocks PRF to EXTERNAL roaming authenticators; Firefox PRF was
  prototype (Bug 1863819) but has PARTIAL support since ~v135 with rollout to
  macOS in v139; Safari 18+ supports PRF with iCloud Keychain platform
  authenticators. Marginally better than 2025, still not a default.
- Therefore the two-tier design in SECURITY_DEEP_DIVE.md is right in shape but
  wrong in emphasis: PRF cannot be the recommended default until platform
  coverage improves. Runtime detection via
  `PublicKeyCredential.getClientCapabilities()` is mandatory; never infer from
  UA tables.

Also correct: ARCHITECTURE.md says PBKDF2 "100,000+ iterations" while
SECURITY_DEEP_DIVE.md says 600,000. Standardize on 600,000 + unique per-vault
salt, AES-GCM-256 with 96-bit random IVs, auto-lock 15 min (existing values).

Sources:
- https://www.w3.org/TR/webauthn-3/ (L3 Recommendation, PRF extension)
- https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html (compat matrix)
- https://bugzilla.mozilla.org/show_bug.cgi?id=1863819 (Firefox PRF status)

---

## 8. Final provisional stack + roadmap impact

| Layer | Decision | Change vs original docs |
|---|---|---|
| UI | React ^19.3 SPA (Vite template), Virtual 3.14.x, Tailwind 4.3.x | None (19.3 adds View Transitions/Fragment Refs/Trusted Types; no React 20 announced) |
| Bundler | Vite 8 default, Bun >= 1.4.2 as runner/PM/tests | Adjusted: `bun build` must pass spike first |
| Editor | CodeMirror 6 (view 6.43.x, merge 6.12.x) | CHANGED (was Monaco) |
| Database | PGlite >= 0.5 (core 0.5.7), IDB VFS, durable mode for vault/ledger | Corrected: IDB first, OPFS-AHP progressive only |
| S3 | Vendored aws4fetch 1.0.20 signing + custom multipart engine | Adjusted (was unspecified hand-rolled signer) |
| Vault | Passphrase primary (PBKDF2-600k), PRF enhancement | Corrected emphasis + KDF params unified |
| Hosting | GitHub Pages v1; Cloudflare Pages documented fallback | Corrected: header/CSP limits acknowledged |

Impact on IMPLEMENTATION_ROADMAP.md:
- Phase 1.2: PGlite worker uses `idb://` backend; OPFS-AHP becomes a stretch goal.
- Phase 1.4: signing spike includes aws4fetch vs SDK bake-off + R2/MinIO/B2 vectors.
- Phase 4.1: Monaco embed replaced by CodeMirror 6 + merge addon; Monaco kept
  only as a possible opt-in "IDE mode" (lazy route, out of main bundle).
- Phase 5.1: CORS helper unchanged; add documented note that header-based CSP
  (frame-ancestors) is unavailable on GH Pages.

## 9. Open spikes (timeboxed, Phase 1)

1. Bun-bundler spike (0.5d): CodeMirror + PGlite wasm + one `?worker` file.
2. PGlite IDB cold-start on 100k-row cache (1d): measure load + first-query
   latency; confirm relaxedDurability behavior.
3. aws4fetch signing parity (0.5d): AWS/R2/MinIO/B2 vectors incl. unicode keys.
4. PRF capability probe (0.5d): getClientCapabilities matrix on target browsers.

---

## 10. Re-verification log — 2026-09-17 (second thorough pass)

Every version pin and platform claim above was re-checked against live sources.
Deltas vs the first pass:

1. Bun 1.4.0 -> 1.4.2 (2026-09-05 current stable; local toolchain verified at
   1.4.2). No action beyond pin bump, plus the 1.4.1 `bun build` regression
   note in section 2.
2. PGlite 0.4 -> 0.5.7 core / react 0.4.7 / pgvector ext 0.0.8 / sync 0.6.8.
   New caution: relaxedDurability silent-persistence-loss fix still open
   upstream - gated in section 4.
3. React 19 -> 19.3 (2026-09-09): View Transitions + Fragment Refs stable,
   React Compiler stable since 19.2, new `browser()` API and Trusted Types
   support (relevant to future CSP hardening). No React 20 on any roadmap.
4. Tailwind 4.3.3 (2026-07-16) current; browser floor unchanged
   (Safari 16.4+ / Chrome 111+ / Firefox 128+).
5. TanStack Virtual 3.14.10; official docs still prescribe
   `useFlushSync: false` for React 19 - keep the flag.
6. CodeMirror actively maintained (view 6.43.9 Aug 2026, merge 6.12.2 Jun 2026).
7. aws4fetch flagged STALE (1.0.20, Aug 2024) - vendoring mitigation in
   section 5.
8. File System Access: still Chromium-only (Safari 26.x + iOS + Firefox
   unsupported, ~74% global per caniuse). Concrete fallback confirmed:
   `<input type="file" webkitdirectory>` works in Safari 11.1+ and
   Firefox 50+ (read-only listing, no write-back) - use it as the
   degraded dual-pane path per web.dev progressive-enhancement pattern.
9. PRF: Firefox partial support landed (135+/139 macOS); Safari 18+ OK for
   platform authenticators. Enhancement-only stance unchanged.
10. GitHub Pages: still no custom response headers (open community discussion
    #199121 unresolved; GHES-only feature). All section 6 constraints stand.

No decision reversals in this pass. Next re-check due when Phase 1 spikes
close or any pinned major (PGlite 0.6, React 20, Tailwind 4.4) ships.

---

## 11. Re-verification log — 2026-09-18 (pass 3: browser feasibility)

This pass stopped asking "which library?" and started asking "does the browser allow it?"
The full write-up is [`FEASIBILITY_AND_RISKS.md`](FEASIBILITY_AND_RISKS.md); summary of what
changes here:

1. **Postgres version is wrong, not just stale.** PGlite has been on **PostgreSQL 18.3**
   since 2026-06-01 (pglite #984; `postgres-pglite` default branch `REL_18_3-pglite`).
   README/ARCHITECTURE/PGLITE_SPEC/TECH_STACK all say "PostgreSQL 16".
2. **VFS decision needs a browser split.** Section 4's "IDB first" is right for
   compatibility, but PGlite's docs state the IndexedDB FS loads *all* database files into
   memory on start and re-flushes whole table/index files after each mutating query. The
   500k-object catalog therefore has a hard WASM-heap ceiling under IDB. Two profiles are
   required: `opfs-ahp://` (Chrome/Edge/Firefox, worker-only) for the full cache, `idb://`
   (Safari/iOS) with a bounded, LRU-evicted catalog. ADJUSTED.
3. **`relaxedDurability` gate still stands, now 2 months old.** PR #1063 and issue #1065
   (transaction-time sync suppression) remain open as of 2026-09-18. Do not enable it for
   the vault or the transfer ledger.
4. **Pin deltas:** PGlite core **0.5.8** / react 0.4.8 / pgvector 0.0.9 / sync 0.6.9;
   CodeMirror view 6.43.12, merge 6.12.2; TanStack Virtual 3.14.13. React 19.3.0, Vite
   8.3.0, Tailwind 4.3.3, Bun 1.4.2 confirmed unchanged.
5. **`aws4fetch` still 1.0.20** (no release since Aug 2024) — vendoring stands. Signing
   refined: use the documented `UNSIGNED-PAYLOAD` option (avoids a second read of every
   part) and move integrity to S3 `x-amz-checksum-*` headers.
6. **Local embeddings package renamed:** `@xenova/transformers` (2.17.2, dormant) ->
   **`@huggingface/transformers` 4.3.0**.
7. **Safari/iOS is a first-class constraint.** ITP deletes IndexedDB and other
   script-writable storage after 7 days without user interaction; only an installed Home
   Screen Web App is exempt. `navigator.storage.persist()` is not documented to lift the
   7-day cap. PWA install + vault export/restore move into Phase 1.
8. **Transfer engine is part-buffered, not streamed.** Browser `fetch` streaming needs
   `duplex:'half'`, HTTP/2, always preflights; S3 `UploadPart` needs a known length. Part
   size (5 MB min, 10,000 parts max) is the memory bound.
9. **Listing cost is linear:** `ListObjectsV2` caps at 1,000 keys/request, so a 500k
   catalog is ~500 requests. "Instant" search is a cache property, not a listing property.
10. **Dual-pane local mode is Chromium-only at the API level** — `showDirectoryPicker` and
    `requestPermission`/`queryPermission` have no Firefox/Safari/iOS support; OPFS exists in
    Firefox/Safari but not iOS.

Spike list §9 is superseded by `FEASIBILITY_AND_RISKS.md` §6 (7 spikes, ~5.5d total).

---

## 12. Re-verification log — 2026-09-22 (pass 4: full stack re-research)

Five parallel research passes against npm, GitHub, MDN, and vendor docs. Method: every
pin, every browser API, and every alternative re-checked from scratch.

**All version pins confirmed current — no drift:**
React 19.3.0, Vite 8.3.0, Bun 1.4.2, Tailwind 4.3.3, TanStack Virtual 3.14.13,
PGlite 0.5.8 / react 0.4.8 / pgvector 0.0.9 / sync 0.6.9, CodeMirror view 6.43.12 /
merge 6.12.2, aws4fetch 1.0.20 (still stale), @huggingface/transformers 4.3.0.

**Changes:**

1. **TypeScript 5.8 → 7.0.2** (released July 8, 2026). Complete compiler rewrite from
   JavaScript to **Go** (Project Corsa). ~10× faster compilation and editor
   responsiveness. Language features are a superset of 5.8/6.0; output is identical JS.
   **Caveat:** TS 7.0 does not yet expose a stable programmatic compiler API;
   `typescript-eslint` requires the `@typescript/typescript6` bridge package. TS 7.1
   (in beta) will stabilize the native API. Pin updated to `^7.0`. ADJUSTED.

2. **Cloudflare Workers Static Assets now recommended over Pages** for new projects.
   Cloudflare steers new deployments to Workers; Pages is maintained but not the forward
   path. Workers Static Assets: same free tier (static requests free & unlimited), same
   `_headers` / `_redirects` support, plus first-class access to Workers primitives
   (D1, R2, Queues, Cron). SPA fallback via `not_found_handling: "single-page-application"`
   keeps it free. Deploy target updated from Pages to Workers Static Assets. ADJUSTED.

3. **`s3-lite-client` — new S3 alternative.** Zero dependencies, ~8 KB gz, browser
   support, built-in multipart uploads, pagination, and streaming. Could replace both
   vendored aws4fetch AND the custom multipart orchestrator. Added to the Phase 1
   signing spike for evaluation alongside aws4fetch. The spike decides. NEW.

4. **WebGPU stable in Safari 18+** (macOS 15, iOS 18, iPadOS 18, visionOS). Chrome/Edge
   stable since 113. Firefox trailing (behind flags). Quantized embedding models achieve
   10–50 ms/batch on WebGPU vs 250–600 ms on WASM. Local vector search upgraded from
   "experimental" to "viable cross-browser with WASM fallback". UPGRADED.

5. **iOS OPFS documentation correction.** `FEASIBILITY_AND_RISKS.md` §2 marks iOS Safari
   OPFS as ✗. Reality: iOS Safari supports OPFS (`navigator.storage.getDirectory()`)
   since iOS 15.2. However, PGlite OPFS-AHP remains blocked by Safari's 252
   `FileSystemSyncAccessHandle` cap vs Postgres's 300+ files. Table corrected to
   "Partial". Architectural split (Full/Bounded profiles) unchanged. CORRECTED.

6. **`relaxedDurability` bug still open** — PR #1063, Issue #1065, PR #1066 all remain
   open as of 2026-09-22 (now 2+ months). Gate unchanged.

7. **cr-sqlite is dead.** Creator moved to Rocicorp to build Zero 1.0 (local-first
   Postgres sync engine — requires backend server, not applicable to Galiot's 100%
   client-side architecture). Dexie 4.x stable as the IDB fallback.

8. **`@codemirror/merge` gained `allowInlineDiffs`** for unified merge views — renders
   minor edits inline rather than multi-line breakaways. Bonus for the config diff UX.

9. **`COEP: credentialless`** now widely supported (Chrome, Firefox, Safari 18+), easing
   cross-origin isolation without requiring `Cross-Origin-Resource-Policy` on third-party
   hosts. Validates the Cloudflare deploy with `_headers`.

10. **WebAuthn PRF** — marginal improvement: Firefox 135+/139+ (partial, macOS), Safari 18+
    (iCloud Keychain platform authenticators). Still not universal. Enhancement-only stance
    unchanged.

**Updated provisional stack (§8 delta only):**

| Layer | Previous | Updated |
|---|---|---|
| Language | TypeScript 5.8+ | **TypeScript ^7.0** |
| S3 Signing | Vendored aws4fetch | Vendored aws4fetch **OR s3-lite-client** (spike decides) |
| Hosting | Cloudflare Pages | **Cloudflare Workers Static Assets** |
| Embeddings | WASM-only | **WebGPU primary + WASM fallback** |

Spike list §9 updated: added spike #8 (TS 7.0 + typescript-eslint bridge, 0.25d) and
expanded spike #5 to include `s3-lite-client` evaluation. Total: ~5.75d.

---

*End of stack decision. Update this file when spikes close; do not edit the
original spec docs retroactively - link corrections from here instead.*
