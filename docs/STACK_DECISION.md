# Galiot — Stack Decision & Technology Comparison

> **Status:** Research complete; decisions provisional until Phase 1 spikes validate them.
> **Date:** 2026-09-17
> **Method:** All claims below verified against official/current sources (linked per section).
> Benchmarks cited are from vendors or public suites and may vary by hardware.

---

## 0. Scope

Galiot is a 100% client-side S3 explorer shipped as a static bundle, hostable on
any static or cloud host. This document compares
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
> Full free-tier comparison for a non-commercial OSS project: `HOSTING_COMPARISON.md`
> (deleted 2026-11-18 when third-party deployment support was removed; see §34).

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

## 13. Re-verification log — 2026-09-24 (pass 5: hosting claims)

**The hosting and cost statements throughout the original specs are obsolete and
are superseded by this entry.**

1. Galiot's build output is a plain static bundle (HTML/JS/CSS/WASM) plus a
   static-host header file. There is no backend, no server-side code, and no
   runtime dependency on any particular provider.
2. Any static host, edge CDN, or object-storage front door can serve it. The
   deployment target is an implementation detail recorded in repository config
   (`wrangler.jsonc`, `.github/workflows/deploy.yml`) and is deliberately not
   restated in the specs or the README.
3. Cost is deliberately not a documented property of the project. The actual
   portability requirements are: the host must support custom response headers
   (CSP incl. `frame-ancestors`, COOP/COEP, HSTS) and SPA fallback routing to
   `index.html`. Both are carried as config (`public/_headers` and
   `not_found_handling`), so the project stays portable across hosts.
4. Bucket-side CORS is unrelated to web hosting — it is enforced by the browser
   against the S3 endpoint, not by the host serving the app.
5. Unchanged by this pass: the 100% client-side architecture and the
   "no secrets in the main thread" vault rule.

Docs changed in the same commit: README rewritten to be provider- and
cost-neutral, and the seven original spec docs received a dated correction
banner instead of being rewritten — per the project rule that corrections live
here, not in the specs.

Superseded by this entry: §6's "GitHub Pages for v1 launch", its "GitHub Pages
as docs mirror" fallback, §12's provider recommendation, and the
"origin isolation on `*.github.io`" analysis in SECURITY_DEEP_DIVE §3.2 — none
of which constrain the architecture that shipped.

No external sources are cited in this entry by design: it makes no
provider-specific or pricing claim, only a portability statement verifiable
from the repository configuration.

---

## 14. Re-verification log — 2026-09-24 (pass 6: worker XML parsing)

**Correction: do not use `DOMParser` anywhere in Galiot, including inside Web
Workers.**

The S3 client originally parsed responses with `new DOMParser()` in
`src/s3/client.ts` and `src/workers/transfer.worker.ts`, on the assumption that
the browser global is available wherever the code runs. Every S3 response is
parsed in the vault or transfer worker, and in Chrome that global does not
exist. Verified empirically in Chrome 153 (macOS, headless) with a blob-URL
dedicated worker:

```
main thread: typeof DOMParser === "function"
worker:      typeof DOMParser === "undefined"
             typeof XMLSerializer === "undefined"
```

The failure mode was worse than a crash: the connection diagnostics classify a
failed request as a CORS block when the endpoint is reachable, so a perfectly
healthy bucket reported "the endpoint answered, but the browser blocked the
response" and offered a CORS fix that could not help. Unit tests could not
catch it, because Bun has no DOM either way — it was found by driving the real
UI in a real browser against a mock bucket and reading the dialog.

Correction applied: `src/s3/xml.ts` (previously a Bun-only shim for the
integrity harness) is now the single reader for both the app and the tooling,
and no `DOMParser`/`XMLSerializer` reference remains in `src/`. The reader is
verbatim rather than trimming, matching the `textContent` behaviour it
replaces, because S3 object keys may legally begin or end with a space.

Sources and scope: this entry claims only the verified Chrome behaviour above
and the resulting repository state. MDN's `DOMParser` page
(https://developer.mozilla.org/en-US/docs/Web/API/DOMParser, last modified
2025-10-13) documents the interface and its `parseFromString` method but does
not state worker availability, so no spec-level claim is made here. The
regression guard is `src/s3/corsRemediation.integration.test.ts` plus the
browser two-phase flow, which exercises the worker path end to end.

Also settled in this pass: the CORS remediation commands no longer assume the
user has configured `mc` or the AWS CLI, which was impossible anyway — the user
has no profile until CORS is fixed. Each generated command is self-contained,
and the default curl path needs no tooling at all because the request is
presigned in the vault worker.

---

## 15. Re-verification log — 2026-09-25 (pass 7: a real S3 server)

**Method.** Ran the app against a real MinIO container
(`quay.io/minio/minio:latest`, RELEASE.2025-09-07T16-13-09Z, arm64) instead of
only mocks and Bun. Reproducible with `./scripts/minio-test.sh`, which starts
the container, creates the buckets, runs `bun run test:integrity` and
`bun run test:minio`, then removes it. MinIO validates SigV4 independently, so
agreement between the two is not circular. MinIO no longer publishes to Docker
Hub; the images are at `quay.io/minio/minio` and `quay.io/minio/mc`.

### Corrections to §5 (S3 client) and §14 (worker parsing)

Five defects were invisible to the unit suite and to every mock, and each broke
a core capability against a real server:

1. **An empty `continuation-token` broke every listing on MinIO.** The client
   sent `continuation-token=` on every ListObjectsV2. AWS S3 ignores it; MinIO
   answers `400 InvalidArgument` — isolated by varying one parameter at a time,
   where only the empty token fails and an empty `delimiter` is fine. The
   explorer could not list any MinIO bucket. Empty parameters are now omitted,
   except subresources such as `?cors=` where the empty value *is* the
   identifier.
2. **The canonical URI was double-encoded.** The vendored signer ran `encodeURI`
   over a path the URL parser had already encoded, so `%20` became `%2520` in the
   signature while the request carried `%20`. MinIO answered
   `403 SignatureDoesNotMatch` for *every* key containing a space or a non-ASCII
   character — "Q3 report.pdf", "写真.jpg", "a&b.csv". `canonicalUri()` now
   decodes and re-encodes per segment, which is idempotent, so a key containing a
   literal `%20` is still encoded exactly once.
3. **`DeleteObjects` never sent `Content-MD5`.** The multi-object delete API
   requires it; MinIO and AWS S3 both answer `400 MissingContentMD5`, so deleting
   a selection failed outright.
4. **S3 error codes were discarded.** Every failure surfaced as a bare status
   line, which is why a `501 NotImplemented` read as a permissions problem.
   `S3RequestError` now carries the server's own code and the UI branches on it.
5. **MinIO has no per-bucket CORS API.** `GET ?cors` answers
   `404 NoSuchCORSConfiguration`, `PUT`/`DELETE ?cors` answer
   `501 NotImplemented`, and `mc cors set` reports the same. CORS is configured
   server-wide with `MINIO_API_CORS_ALLOW_ORIGIN`, or at runtime with
   `mc admin config set api cors_allow_origin=…` plus a restart. The remediation
   UI now detects the unsupported API and says so, instead of offering a curl,
   AWS CLI or bridge path that cannot succeed — and it no longer claims "the
   browser will block every request" once a signed request has succeeded, which is
   the normal state on MinIO because it allows every origin by default.

### Corrections to the transfer-integrity suite itself

Partly vacuous and partly broken, and only a real server showed it: the suite
signed a request and then fetched `signed.url` with a fresh init, dropping the
`Authorization` header (the 403s on ListParts and Range); it appended a part
count to an ETag that `multipartEtag()` had already suffixed; and it verified a
multipart ETag string it had constructed itself, printing "bucket said" for a
value it had invented. It now sends the signed `Request` and verifies against
the ETag the bucket actually reported.

### Scope

MinIO is one implementation. R2, AWS S3, B2, Wasabi, Ceph and SeaweedFS were not
exercised here, so no compatibility claim is made for them beyond §5. The
multipart **transfer worker** path was verified through the client and through a
live browser listing, not by driving a multi-part upload through the browser UI.

### Follow-up in the same pass: browser coverage of the worker paths

Driving the real UI against the same container closed the gaps the Bun suites
cannot reach, and found one more defect:

6. **Every plain-text file opened a dead editor.** The editor's mount effect
   waited for a CodeMirror language grammar, but `languageSupport('text')`
   resolves to `undefined` *on purpose* — plain text has no grammar. The gate
   therefore never opened for `.txt`, `.log`, `.csv` or any unknown extension:
   no editor, no spinner, no error, just an inert panel. The same guard blocked
   the Diff view. Fixed by separating "resolution finished" from "a grammar was
   found" (`canMountEditor`, with unit tests, since the repository has no DOM
   test environment).

Verified in the browser against MinIO, all through workers:

- a 40 MiB file (three 16 MiB parts, above the 32 MiB single-PUT threshold)
  uploaded through the transfer drawer, then downloaded with MinIO's own client
  and compared byte-for-byte; the app's multipart ETag recomputation matched the
  server's exactly;
- the editor loading, editing and saving a file whose name contains spaces,
  unicode and parentheses, with the change confirmed server-side;
- a Galeon export imported into a real bucket and browsed, with the
  credential-less profile skipped and the reason shown;
- the explorer listing and navigating into a subfolder;
- a change made through the app appearing in the already-open listing with no
  reload.

One observation, not a defect: PGlite's `live` extension logs
`invalid byte sequence for encoding "UTF8": 0x00` from its BroadcastChannel in
this environment. It is not data-dependent (identical with and without binary
objects in the bucket) and reactivity is unaffected — uploads, edits and imports
all reach the open UI without a reload. Recorded here so a future report of
stale listings starts from this rather than re-investigating it.

---

## 16. Re-verification log — 2026-09-25 (pass 8: a third-party on-premises gateway)

A user reported Galiot failing against a real corporate S3 endpoint. The
endpoint's name is deliberately not recorded anywhere in this repository (see
the Hostnames rule in `AGENTS.md`); it is described as *an on-premises
converged-storage S3 gateway*, vendor ViPR, answering on a non-standard port
over TLS with a public wildcard certificate.

### What the endpoint actually is

Every claim below was measured directly against the live service, not inferred
from Galiot's behaviour.

| Probe | Result | Consequence |
|---|---|---|
| DNS `A` | an RFC 1918 address | reachable only from inside the organisation's network or its VPN — not the cause of the failure below |
| TCP to the service port | open; 9000/9001 closed | the port is correct |
| TLS handshake | valid wildcard certificate, unexpired | `https://` is correct; plain HTTP on the same port returns an empty reply |
| `GET /` | `403`, `Server: ViPR/1.0`, S3 XML `<Error><Code>AccessDenied</Code>` | it speaks the S3 protocol |
| Signed `ListObjectsV2`, path-style, from Bun (no browser) | `403 InvalidAccessKeyId` | **SigV4 and path-style addressing both work**; the service is a complete S3 implementation |
| Same request, virtual-hosted | `getaddrinfo ENOTFOUND` | **no wildcard DNS**, so bucket-subdomain addressing is impossible here |
| `OPTIONS` with preflight headers | `405 Method Not Allowed` | the gateway does not implement CORS preflight at all |
| `Access-Control-*` on any response | absent | a browser can never read a response from it |
| Request via the local bridge | `403 InvalidAccessKeyId` (a real S3 error) | the bridge is a working path; only credentials remain |

Two independent, unrelated blockers were therefore stacked behind one error
message: **addressing** (path-style is mandatory) and **CORS** (the gateway
sends no CORS headers and rejects preflight, so no browser can use it directly
however the request is formed).

A vendor-specific detail worth recording: anonymous requests are refused with
*"Could not determine namespace from anonymous request. Please use a namespace
BaseURL or include an `x-emc-namespace` header"*. No such header is needed — a
signed path-style request carries the namespace in the bucket, which is why the
signed request above reached the key check. The message is a red herring for a
client that signs correctly.

### Defect 1: a dead probe that reported every host as unreachable

`src/s3/diagnostics.ts` contained a second copy of the reachability probe,
unused by any caller and covered by no test. It passed `redirect: 'manual'`
together with `mode: 'no-cors'` — the exact combination its own comment warned
against. Measured in a real browser:

| Target | `no-cors` + `redirect: 'manual'` | `no-cors` alone |
|---|---|---|
| the reported gateway | `TypeError: Failed to fetch` | opaque response |
| a public site | `TypeError: Failed to fetch` | opaque response |
| a refused port | `TypeError: Failed to fetch` | `TypeError` |

Chrome rejects the combination outright, so that copy would have declared the
entire internet unreachable. The live probe in `S3Client` was already correct;
the dead copy was a trap for whoever reached for the documented helper next.
Removed, with the browser constraint recorded where the verdict consumes it and
pinned by a test.

### Defect 2: a failed probe was reported as a network fault

With the live probe, a failed reachability check was still shown as *"The
endpoint did not respond at all… network, DNS, port or TLS — not CORS"*, with
the hint to check the host and port or try `http://`. Against this gateway that
advice had nothing to act on: the host answered fine, and the probe had dialled
`bucket.<host>`, which does not resolve. A single failed `fetch` cannot tell
those two situations apart.

`S3Client.probeAddressing()` now tries the *other* addressing form whenever the
first fails, which is decisive because addressing is the only variable.
`diagnoseCors` then reports `addressing-unsupported`, naming the URL that
responded — and the connection dialog already repaired that verdict
automatically by switching the toggle and asking for a re-test, so the
misconfiguration now fixes itself.

### Defect 3: CORS advice that could not work

The `cors-blocked` hint told the user to apply the generated policy. On a
gateway that answers `OPTIONS` with `405` and emits no CORS headers, no policy
can help. The hint now also points at the local bridge, which makes the same
signed request from the user's machine where CORS does not apply — verified
above against this endpoint.

### Evidence

```sh
dig +short <host> A                                  # RFC 1918 address
nc -vz -G 5 <host> <port>                            # TCP open
curl -sv https://<host>:<port>/ 2>&1 | grep -E 'subject|SSL certificate|HTTP/'
curl -s -X OPTIONS -D - -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' https://<host>:<port>/
dig +short <bucket>.<host> A                         # no record
```

The browser behaviours in the tables above were measured in headless Chrome via
the DevTools protocol; the signed-request rows were measured with the project's
own client from Bun, where no browser and therefore no CORS is involved.

### One correction to §0

§0 still described Galiot as "hosted on GitHub Pages". Per the project's
documentation rule, the deliverable is a static bundle hostable on any static
or cloud host; the line now says so, without naming a provider or discussing
hosting cost.

---

## 17. Re-verification log — 2026-09-26 (optional local companion traffic)

The same on-premises S3 gateway was later given a matching bucket CORS rule.
A credential-free `OPTIONS` request to the path-style bucket URL still returned
`404 NoSuchBucket` without `Access-Control-Allow-Origin`; a plain anonymous
`GET` said ECS could not determine a namespace. A signed CLI `GetBucketCors`
can read the policy because it is not the browser's anonymous preflight. Dell
describes this namespace/Base URL requirement for ECS CORS
[here](https://www.dell.com/community/en/conversations/ecs/cors-allowed-origin-issue/647f63c3f4ccf8a8de00e7d9?commentId=647f63b6f4ccf8a8deffdc4f).

There is no browser switch for skipping the preflight on SigV4 requests carrying
`Authorization`. `no-cors` makes the response opaque and unusable by the
explorer, according to [MDN's Fetch guidance](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch).
Because the user cannot change the gateway's namespace Base URL, the existing
optional local companion now also forwards signed S3 requests. A saved
connection enables it from the frontend after the user starts the companion
and enters its short-lived token. Tokens stay in tab memory and are cleared on
vault lock. The companion still requires an allowed page origin and a token;
only its exact loopback origin is added to production `connect-src`.

The browser can preflight the companion, which answers `OPTIONS`; the companion
then calls S3 without browser CORS. Browser local-network permission can also
apply to a deployed page talking to loopback; see [Chrome's local network access
guidance](https://developer.chrome.com/blog/local-network-access). Presigned
share links still point directly at S3 and are outside this routing mode.

Verification: the local companion integration test checks preflight, binary
forwarding, response headers, and token rejection; the full `bun test` suite
passed with loopback networking enabled.

---

## 18. Re-verification log — 2026-09-26 (browser companion downloads)

The source repository is private, so release assets there cannot serve as
anonymous downloads for a public static page. The site build now uses [Bun's
single-file executable compilation](https://bun.sh/docs/bundler/executables)
to package macOS Apple Silicon, macOS Intel, Windows x64, and Linux x64
companions. The packages are ZIP files with executable permissions where
needed. Users choose a platform from the connection card, download the ZIP,
extract it, and run the companion locally.

The ZIPs are split into 20 MiB static parts and reassembled on download.
This keeps each deployed asset below [Cloudflare Workers' 25 MiB per-file
limit](https://developers.cloudflare.com/workers/platform/limits/#static-assets)
without adding a binary hosting account. The app fetches the manifest from its
own origin and checks every part with [Fetch subresource
integrity](https://developer.mozilla.org/en-US/docs/Web/API/RequestInit#integrity)
and an exact byte count before offering the ZIP.
The companion's allowed-origin and token requirements remain the same.

---

## 19. Re-verification log — 2026-09-26 (one companion for all connections)

The per-connection controls described in §§17–18 have been replaced by one
companion panel above the connection list. Enabling it validates one token and
routes signed requests for every connection in the current tab, including
connections added afterward. The token remains in tab memory and is cleared
when the vault locks or the user disables the companion. Connection tests,
object operations, and transfer jobs all read the same session token; see
[`src/bridge/session.ts`](../src/bridge/session.ts),
[`src/db/objects.ts`](../src/db/objects.ts), and
[`src/components/ConnectionDialog.tsx`](../src/components/ConnectionDialog.tsx).

This changes only browser routing. The companion still binds loopback,
requires its token and an explicitly allowed page origin, and cannot make
presigned share links reachable to recipients. A global opt-in is visible
before any connections are saved so a new connection can be tested through
the companion immediately. The panel explains that it is optional and useful
for browser CORS/preflight failures when the local computer can reach the
gateway; ordinary working connections can leave it off.

---

## 20. Re-verification log — server-side S3, not a platform function

The browser still signs every S3 request in the vault worker. Raw keys do not
move to the server or the main thread. What changed is where the signed request
is sent:

- **Server network** (default for new connections): the browser posts the signed
  request to same-origin `/api/s3-proxy`. A plain Bun process (`scripts/server.ts`,
  also mounted in Vite dev) forwards it with `fetch`. Bucket CORS is not required.
  Traffic leaves from the machine running Galiot.
- **This device's network**: the browser calls S3 itself. Use this when the
  endpoint is only reachable from the user's network (VPN, office LAN, local
  MinIO). Bucket CORS, or the existing local companion, still applies.

The server is not a Cloudflare Worker and not a Vercel function. `bun run server`
and the `Dockerfile` are the way to run it. A non-loopback bind requires
`GALIOT_PROXY_TOKEN` so a public process is not an open proxy; loopback does not.
Redirects are not followed. Literal link-local targets, including cloud metadata
addresses, are refused. Private LAN addresses stay allowed so the server can
reach a MinIO on its own network.

Existing vaults migrate to `user` so a connection that already worked from the
browser keeps doing so. New connections and the fresh schema default to `server`.
Presigned share links are unchanged: they still open from the recipient's browser.

`wrangler deploy` is no longer the creation path. `vercel.json` and `public/_headers`
remain so a static host can still serve the bundle for device-network use; they
are not required to run Galiot.

---

## 21. Re-verification log — server network only

Signed S3 calls now have one route. The browser signs the request in the vault
worker and posts it to same-origin `/api/s3-proxy`. The Bun process calls S3.
`S3Client` and the transfer worker no longer fall through to `fetch` against
the bucket, and they no longer forward through the local companion.

The connection dialog no longer offers "This device's network". Saves write
`profiles.network = 'server'`. Schema version 4 rewrites any stored `user` row
to `server`. A vault backup that still says `user` is restored as `server`.
`parseNetwork` ignores a leftover `user` value.

The companion panel, the downloadable bridge packages, and the
`http://127.0.0.1:8787` CSP exception are removed with that route. `bun run build`
is `vite build`. Presigned share links and media previews still open the object
URL in a browser, so those loads use the viewer's network.

The machine running Galiot has to reach the endpoint. A bucket that is only
routable from a laptop VPN is unreachable from a server that is not on that VPN.

---

## 22. Re-verification log — server-side S3 connection

The signed-request proxy is no longer the product path. Galiot is a self-hosted
app. `bun run server` (or the container) signs with the vendored aws4fetch and
opens the TCP connection itself. The browser calls `/api/s3` on the same origin.

What changed:

- A session is created on the server. Credentials are held in memory, wiped on
  lock or expiry, and are not written to disk. The browser vault still seals
  them at rest and still keeps the DEK off the main thread.
- Listing, edit, preview, and transfer bytes go through that session. Preview
  uses a same-origin media URL, so the visitor's browser does not need a route
  to the bucket.
- Share links are still presigned S3 URLs. The recipient's network has to reach
  S3. That is a different path from the app.
- The host running Galiot must be able to resolve and connect to the endpoint,
  including a private MinIO or an on-premises gateway. Link-local and metadata
  addresses stay blocked. Private LAN addresses stay allowed.
- A non-loopback bind still refuses to start without `GALIOT_PROXY_TOKEN` or
  `GALIOT_GATE`. That gate is not an S3 key.
- `connect-src` is `'self'`. The page cannot open its own connection to S3.

A static file host is not a supported way to use the app. There is no platform
function and no provider-specific deploy step.

---

## 23. Re-verification log — server-side file operations and share routes

The explorer gained the file actions a browser needs, all executed by the
server inside S3: `CopyObject` for objects up to 5 GiB, multipart
`UploadPartCopy` above that, rename/move as copy-then-delete, folder creation
as an empty slash-terminated PUT, and `HeadObject` for object details
including storage class. Folder walks are capped at 10,000 objects.
`ListBuckets` is offered in the connection form when the key allows it;
`AccessDenied` falls back to typing the bucket name, with that said plainly.

Share links now have two explicit routes. The default streams from the Galiot
server through a revocable, expiring grant, so a recipient who cannot reach S3
can still download. The presigned S3 URL remains as the "Direct S3" option and
for write links; it cannot be revoked and uses the recipient's network.

Motivation, verified: MinIO's community console lost its management UI in May
2025 (maintainer statement in minio/minio#21317), and the repository was
archived in April 2026. Self-hosted S3 still needs a usable browser, and the
host that can reach a private bucket is usually a server, not a laptop.

Sources:
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html (5 GiB single-copy limit; UploadPartCopy above it)
- https://github.com/minio/minio/issues/21317 (community console scope, maintainer comment 2025-05-26; archive notice 2026-04-25)

Operator guidance lives in `docs/OPERATIONS.md`.

---

## 24. Re-verification log — live server path, and two defects it caught

**Stale transfer sessions.** The transfer worker cached server session ids and
never invalidated them, so a vault lock (manual or 15-minute idle) left
in-flight and resumed transfers sending dead ids. The worker now clears its
cache on a `sessions-closed` port notice from the vault worker, and reopens once
when the server answers its own expired-session 404. An S3 `NoSuchKey` 404 is
XML, not that JSON, and does not trigger a reopen (`src/transfer/session.ts`,
unit-tested).

**Server-originated PUTs had no Content-Length.** With signing moved to the
server, a PUT whose body is a string went out chunked: no browser remained to
add the length header. Zenko CloudServer answered `411 MissingContentLength`.
The client now supplies Content-Length for known-size bodies before signing
(`bodyByteLength` in `src/s3/client.ts`); streamed uploads already carry the
length from the API layer. Regression-tested in `src/server/api.test.ts`.

**MinIO images are gone; the live suite moved.** Verified 2026-11-17:
`quay.io/minio/minio:latest` and a pinned 2025 release both answer 401, and
Docker Hub denies `minio/minio`. Upstream was archived 2026-04-25. The live
suite (`scripts/live-s3-test.sh`) now runs Zenko CloudServer, an independent S3
implementation with its own SigV4 validation; `scripts/minio-test.sh` remains
for cached MinIO images. Results against CloudServer: transfer integrity 22/22,
server path 19/19 (sessions, gate refusal, multipart parts, byte-exact download,
range resume at a part boundary, folder copy/rename, share read without the
gate, gated revoke, link survival after session close, list-buckets, cleanup).

**Visual verification limit.** The rendered check covers the unlock gate and
header at desktop and phone widths. Deeper screens need a master password, and
the interactive browser tool refuses credential entry, so explorer dialogs and
the share routes remain verified by types, unit tests, and the live suite only.

---

## 25. Re-verification log — versions, bucket search, connection sharing

**Object versions.** `ListObjectVersions` filtered to the exact key, with delete
markers shown as such; a never-versioned bucket reports `unversioned` instead of
a fake history. Restore is a server-side `CopyObject` with
`x-amz-copy-source: /bucket/key?versionId=…` onto the same key, so it becomes a
new latest version and nothing is overwritten lossily. Old versions download
through a media grant that carries the versionId; purge deletes one exact
version (two-click confirm). All server-side; unit and live tested.

**Whole-bucket search.** The explorer's search only covered the cached folder.
A server walk (no delimiter, capped 50,000 keys / 500 matches, continuation
tokens honoured) now answers "search whole bucket", with the cap stated in the
result line. Clicking a match jumps to its folder.

**Connection sharing.** Saved profiles already existed (PGlite `profiles`,
sealed credentials), as did ciphertext-only vault backup/restore and Galeon
import. Added: secret-free connection export/import (`galiot.connection` v1,
copy JSON or save file; import prefills the connection form with blank keys).
The parser refuses any payload carrying credential fields and re-screens
headers, so a hand-edited "share" cannot smuggle keys. Moving keys remains the
vault backup's job, under its passphrase — documented in OPERATIONS §6.

Live results against Zenko CloudServer: integrity 22/22, server path 25/25
including versioning enable, two-version listing, restore-to-current, old
version download through the server, single-version purge, bucket search, and
full version cleanup. Unit suite 394 tests.

---

## 26. Re-verification log — bulk downloads, cold storage, keyboard, ECS

**Folder and bulk downloads.** Download and drop-to-local now expand folders
through a capped server walk (`listTree`, 10,000 objects) into one transfer per
object, carrying relative names; the local-folder write path creates nested
directories so structure survives (`src/transfer/paths.ts`, unit-tested).
Archived objects are counted in the notice rather than silently skipped.

**Cold storage.** Archive classes (GLACIER, DEEP_ARCHIVE, GLACIER_IR) show a
snowflake in list and grid; Details reads `x-amz-restore` and offers
`RestoreObject` with a days choice; a failed transfer with `InvalidObjectState`
says to restore first. Providers without archive tiers answer 501, surfaced as
unsupported (unit-tested).

**Keyboard.** ⌘K/Ctrl+K opens a palette over existing actions; arrow keys move
selection, shift extends from the anchor, Enter opens. No new server surface.

**Dell ECS / ObjectScale.** Compatible by protocol through the server path.
Verified from vendor documentation: S3 on 9020/9021 (Dell default port table via
the Kemp ECS guide), path-style required (Starburst Dell connector docs),
`GetBucketLocation` unsupported per Dell's S3 matrix — Galiot never calls it.
Namespace rides as `x-emc-namespace` custom header. Added a ListObjects v1
marker-paging fallback for ECS/ViPR-family gateways without v2; the mode sticks
for the session so pages do not flip back (unit-tested). ECS itself remains
unexercised live here; OPERATIONS §8 says so and points at the live suite.

Sources:
- https://docs.progress.com/bundle/ecs-connection-manager-deployment-guide-kemp-ecs-connection-manager-ga/page/hqi1696458877261.html (ports; Dell S3 guidance)
- https://starburstdata.github.io/latest/connector/starburst-dell-object-storage.html (path-style for ECS/ObjectScale)

---

## 27. Re-verification log — live against real AWS S3

Ran `scripts/server-minio-test.ts` against `https://s3.us-east-1.amazonaws.com`
with a throwaway bucket (`galiot-live-…`), using the operator's `galiot` AWS
profile and temporary credentials. **26/26 checks passed**: sessions and gate,
listing, put/head, multipart parts, byte-exact download, range resume, folder
copy/rename, share read/revoke/survival, list-buckets, versioning enable,
two-version listing, restore-to-current, old-version download, single-version
purge, bucket search, listTree, and full cleanup. The bucket was then emptied
of versions and markers and deleted; HeadBucket confirms 404. No other bucket
or resource was modified.

One harness defect found and fixed: the suite's direct signer for the
versioning step omitted the STS session token, so temporary credentials got
403 there while every server-session call (which carried the token) worked.
The signer now passes it (`sessionToken: sts`). Also added: when a key lacks
`s3:PutBucketVersioning` (403), the versioning checks skip with an explanation
instead of failing — a permission boundary is not a Galiot defect.

AWS S3 joins Zenko CloudServer and MinIO-family as exercised implementations.
R2 and B2 remain unexercised.

---

## 28. Re-verification log — live against a Dell ECS dev gateway, scoped

R2 and B2 are skipped by operator decision (no accounts). ECS was exercised
live against an on-premises ECS dev gateway (endpoint and bucket belong to
another project; neither is named here, per the Hostnames rule), using
credentials the operator authorised from Galeon's OS-keychain store.

Because the bucket is not ours, the suite gained **scoped mode**
(`GALIOT_LIVE_SCOPED=1`): every object read and write stays inside the run's
own `server-suite-<ts>/` prefix, bucket-level configuration is never touched
(versioning checks skip), search walks only that prefix, and cleanup removes
only that prefix. Result: **20/20 checks** — sessions/gate, listing, put/head,
multipart parts, byte-exact download, range resume, folder copy/rename, share
read/revoke/survival, prefix search, listTree, cleanup. An independent sweep
afterwards found zero objects under any test prefix.

Observed permission boundaries, handled as skips with the provider's code:
`ListBuckets` → `AccessDenied` (bucket-scoped key). The first scoped run
stopped at that check before cleanup; the leftovers (4 objects) were removed
by a prefix-only sweep before the suite was fixed and re-run.

ECS behaviour confirmed live: SigV4 with path-style on 9021, ListObjects
paging, multipart upload and completion, CopyObject, multi-delete with
Content-MD5, range GET, and presigned-free server streaming all work. The
ListObjects v1 fallback (§26) remains for older gateways; this one answered
the v2 path.

---

## 29. Re-verification log — folder uploads and object-lock awareness

**Folder uploads.** The mirror of folder downloads: an "Upload folder" picker
(`webkitdirectory`) and directory-aware drag & drop (`DataTransfer` entry API,
`src/localfs/dropEntries.ts`, capped at 2000 files with a stated truncation)
enqueue one upload per file with relative keys, so structure survives. Keys
are sanitised through `uploadKey` (traversal and empty segments dropped);
`relativeNameOf` prefers the picker's relative path. The transfer ledger
records the relative path as `local_path`. Pure naming helpers unit-tested.

**Object lock / retention.** HeadObject now surfaces
`x-amz-object-lock-mode`, `-retain-until-date`, and `-legal-hold`. Details
shows them with a plain-language warning. Before single-object delete,
rename, and copy-over, Galiot heads the source and refuses early with the
retain-until date or legal-hold state instead of letting the provider reject
a confusing `AccessDenied`. Providers that do not send these headers (some
ECS retention configurations) simply show nothing; the provider's refusal
code still surfaces unchanged.

---

## 30. Backlog — deferred and next work (not yet in any original spec)

Recorded here so nothing promised in conversation is lost. Ordered by value:

1. ~~Server-mediated write share links.~~ **Done — see §32.** Upload grants
   (single key, byte cap, expiry, revoke, gate-only management) now exist.
2. **Responsive and accessibility pass.** Done (§33): code guards, rendered gate
   check at 1440/768/390, and rendered-DOM dialog checks (happy-dom). Only
   pixel-level browser inspection of vault-gated screens remains, which needs an
   operator to unlock the isolated browser (the tool will not type a password).
3. ~~Ops packaging.~~ **Done — see §34.** GHCR publish on tag, Dockerfile
   HEALTHCHECK, compose example.
4. **Multi-operator server-stored connections.** Only worth building if several
   people share one Galiot host without each holding S3 keys. Today the
   browser vault + secret-free connection share + ciphertext vault backup
   cover single-operator and hand-off cases; server-stored keys would change
   the threat model and need their own design.
5. **R2 and B2 live verification.** Skipped by operator decision (no accounts).
   The suites are endpoint-agnostic; run them when accounts exist.

Done since the original roadmap and not repeated here: server-side S3 path,
file operations, versions, bucket search, share routes, bulk/folder transfers,
cold storage, keyboard flow, live verification (AWS, ECS scoped, Zenko).

---

## 31. Evaluation — Elysia and TanStack Start (asked 2026-11-17, not adopted)

**Elysia.** There is no "Elysia 2": npm `elysia@latest` is **1.4.32**. Adoption
would be cheap and compatible: the whole server core is a framework-agnostic
`(Request) => Promise<Response>` (`handleAppRequest`), so Elysia could sit in
front as a thin adapter on the same Bun runtime, adding TypeBox validation,
OpenAPI, and plugins. Costs: one dependency, an adapter layer, and re-verifying
stream/abort passthrough; the Vite dev middleware would still call the core
directly (Elysia is not connect middleware). No vault/PGlite/transfer/S3 logic
changes. Not adopted: the API is one handler plus a session store with
hand-rolled, tested validation; no functional gain today.

**TanStack Start.** npm `@tanstack/react-start@latest` is **1.169.5**, with
`engines: node >=22.12` — our runtime is Bun. Start does offer SPA mode
(`ssr: false`), but its server functions/routes still require its own server
runtime, replacing the deliberate plain Bun server. Conflicts with this
product: (1) the shell injects inline serialization scripts, against the
no-inline-script CSP rule unless nonce/hash plumbing is added; (2) all crypto
and PGlite must stay client-side by design, so SSR/server-functions bring no
place to put the logic we actually have; (3) the app has no router today —
file-based routing is a real restructure for zero SEO value behind a vault
gate. Workers/WASM would still bundle (Vite-based), and the live suites are
HTTP-level so they would survive. Verdict: possible in SPA mode with careful
CSP, high cost, ~no benefit. If type-safe routing is ever wanted, TanStack
Router client-only (`--router-only`) is the proportionate choice, not Start.

**Decision: keep Vite 8 SPA + plain Bun server.** Revisit Elysia only if the
API grows enough to want schema/OpenAPI tooling; revisit routing only if the
shell outgrows conditional views.

Sources:
- https://registry.npmjs.org/elysia/latest (1.4.32)
- https://registry.npmjs.org/@tanstack/react-start/latest (1.169.5; engines node >=22.12)
- https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode (SPA mode caveats; server functions/routes still need a server)

---

## 32. Write share links — bounded upload grants (backlog item 1, done)

Recipients who cannot reach S3 can now upload through the Galiot host. A write
grant is the read-grant mechanism with a write kind and a byte cap:

- **Bounds:** one exact key; `maxBytes` (default 100 MiB, max 1 GiB, chosen at
  creation); expiry 60 s…7 days; revocable. The credential snapshot is wiped on
  expiry/revoke and outlives the minting session, like read grants.
- **Route:** `PUT /api/s3/upload/:token` only. `Content-Length` is required
  (411/400 otherwise) and checked against the cap up front (413); streamed
  bytes are also counted and the transfer aborted if a body lies about its
  length (413). GET/HEAD on an upload grant → 405; PUT on a read grant → 405.
- **Management:** minting (`shareWrite`) and revoking (DELETE, gate-protected)
  are operator actions; the PUT itself is the bearer capability, same trust
  model as read links. No gate on the PUT by design — the link is the secret.
- **UI:** Share dialog offers the route toggle for write links too, with a cap
  selector and a curl one-liner; history badges and revoke cover both kinds.

Verified: unit tests (bounded PUT, over-cap 413, missing length 411, wrong
method 405, anonymous revoke 403, revoked 404, read-grant PUT 405) and live
against Zenko CloudServer: 31/31 server-path checks including upload landing
in S3 byte-exact. Presigned S3 PUT remains the explicit "Direct S3" option.

---

## 33. Responsive and accessibility pass (backlog item 2, code pass)

- **Focus management:** `useFocusTrap` (Tab cycles inside the modal, focus
  restored on close) applied to all eight dialogs plus the inline vault-settings
  modal (active only while open). Dialogs carry `role="dialog"`, `aria-modal`,
  and a labelled heading.
- **Semantics:** object list/grid is a multiselectable listbox with
  `aria-selected` rows; transfer bars are progressbars with values; vault gate
  errors/notices are `alert`/`status`; palette is a labelled dialog.
- **Responsive:** explorer toolbar wraps; search takes a full row below `sm`;
  filter panel clamped to viewport width; action labels collapse to icons
  below `md`.
- **Contrast:** light-mode zinc-400 text (≈2.6:1) replaced with zinc-500
  (≈4.6:1); dark captions moved zinc-500 → zinc-400; placeholders likewise.
- **Motion:** global `prefers-reduced-motion` block; loading state remains
  conveyed by text and colour.
- **Guards:** `src/components/a11y.test.ts` asserts the wiring as source (no DOM
  env in the unit suite), same pattern as the signing guards.

Rendered check: the unlock gate and header were verified at 1440/768/390 — no
overflow, visible focus ring, real labels, corrected contrast and copy. Screens
behind the vault (connections, explorer, dialogs, palette) were NOT pixel-
verified in a browser: the isolated profile has no vault, and creating one needs
a master password the interactive tool refuses to enter (a boundary not bypassed
via other tools). Instead, `src/components/renderA11y.test.tsx` mounts the vault-gated dialogs and
aux surfaces in a real DOM (happy-dom) and asserts the rendered accessibility
contract — dialog role, aria-modal, labelled heading, associated input labels,
named actions, a key-free share payload, the filter panel's aria-expanded toggle,
and the local pane's "not remote storage" framing. Covers ObjectActionDialog,
ShareConnectionDialog, CommandPalette, BucketSearchDialog, LocalPane,
ExplorerFilterBar and CustomHeadersField. Explorer toolbar responsiveness
remains covered by the wrapping classes and source guards. 421 unit tests pass;
typecheck and build clean.

**Browser pixel pass (2026-11-18, follow-up).** A fresh isolated `browser_use`
session re-verified the real unlock gate at 1440/768/390 (no overflow, visible
initial focus ring). Because the interactive tool will not enter a master
password, the vault-gated surfaces were pixel-checked in a throwaway loopback
preview that mounts the real components over an in-memory PGlite with stubbed
S3 responses (no credentials, no real bucket, removed afterwards). Verified:
empty + populated Buckets, explorer + filter panel, whole-bucket search results,
object details/versions, command palette (ArrowDown moves the highlight), and
the connection / new-folder / rename / copy / share / share-connection dialogs;
Tab stays trapped and Escape dismisses. The page-level overflow flag alone
missed clipping, so screenshots were the authority. Three regressions found and
fixed:

1. **390px populated Buckets toolbar clipped “Add connection.”** Header and
   action row now `flex-wrap` with a gap; the Galeon import collapses to an icon
   with `aria-label` below `sm` (ConnectionsView).
2. **768/390px explorer breadcrumb collapsed to a few characters.** The path
   `nav` gains `min-w-40` so it keeps a readable width and the toolbar wraps
   instead of squeezing it (Explorer).
3. **390px floating Transfers pill overlapped the explorer status text.** The
   status bar reserves `pb-12` below `sm` so the pill sits clear of it (Explorer).

Each fix is locked by a source guard in `a11y.test.ts` (“responsive layout
guards”). 424 unit tests pass; typecheck and build clean. Live vault-unlock and
real-S3 rendering remain outside this pass by design.

---

## 34. Public-repo preparation and ops packaging (2026-11-18)

**Third-party deployment removed.** `vercel.json`, `wrangler.jsonc`,
`public/_headers`, `docs/HOSTING_COMPARISON.md`, and `LAUNCH.md` are deleted;
the `wrangler` devDependency is gone. Security headers now have a single source
(`src/server/securityHeaders.ts`), applied by the Bun server and mirrored by
the index.html meta CSP; `src/releaseConfig.test.ts` guards that no platform
config returns and that the two policies match (minus `frame-ancestors`, inert
in meta). The service worker never caches `/api/` or non-GET responses. CI
smokes `/api/health` and asserts the CSP and nosniff headers on `/`.

**Public under MIT.** LICENSE already MIT. Added SECURITY.md (private advisory
reporting; honest trust model: the server is not zero-knowledge while sessions
are open) and CONTRIBUTING.md (setup, checks, live-suite rules, conventions).
README refreshed: name-etymology section removed by operator request, stale
hosting/client-only claims corrected, license and security/contributing
sections added. Historical specs keep correction banners; SECURITY_DEEP_DIVE
gains a "Current security model (2026-11)" layer because its zero-knowledge
server framing became materially false.

**Ops packaging (backlog item 3).** `.github/workflows/release.yml` publishes
the container to `ghcr.io/fiztoz/galiot` on `v*` tags (semver + latest), all
actions SHA-pinned; Dockerfile gains a HEALTHCHECK against `/api/health`;
`deploy/compose.example.yml` shows a gated single-service deployment with no
volumes (no server-side state). OPERATIONS §1 documents the image and compose
path.

---

## 35. Removal of browser-route code (2026-11-21)

Every S3 request has been signed and sent by the server since §22, so the code
written for the client-only design (README §2's original model, ARCHITECTURE
§2) had no remaining caller. Removed:

- **Bucket CORS management**: `src/s3/corsPolicy.ts`, `src/s3/corsRemediation.ts`,
  the `s3.cors.*` vault methods, the `corsGet/corsPut/corsDelete/corsPresign`
  server operations, `presignPutBucketCors`, and `S3Client` get/put/delete
  bucket CORS. No screen used them. Removing the server operations also takes
  away the ability of anyone holding the access gate to rewrite a bucket's
  CORS policy. §15 and §16's CORS findings describe the removed helper.
- **Browser reachability probes**: `S3Client.probeReachable` and
  `probeAddressing` (`mode: 'no-cors'`). The server probe in `api.ts` replaces
  them; the MinIO suite checks reachability with a real listing.
- **Browser-route diagnosis**: `src/s3/diagnostics.ts` became
  `src/s3/connectionDiagnosis.ts` with only the verdicts the server route can
  produce (no `cors-blocked`, no missing-scheme probe).
- **Retired forwarder**: `handleS3Proxy`, `/api/s3-proxy` and the
  `x-galiot-s3-target` header. Its integration tests now drive `forwardRequest`,
  the transport the server uses, directly.
- **Signing leftovers**: `src/workers/s3-signer.worker.ts`,
  `src/server/transport.ts`, `src/transfer/signing.ts`.

Kept on purpose: `parseNetwork` and the `profiles.network` column (old vaults
still carry it), the `x-galiot-proxy-token` alias and `GALIOT_PROXY_TOKEN` /
`GALIOT_PROXY_OPEN` names (existing deployments set them), and the
`x-galiot-bridge-target` refusal in custom headers (old rows may hold it).

---

*End of stack decision. Update this file when spikes close; do not edit the
original spec docs retroactively - link corrections from here instead.*
