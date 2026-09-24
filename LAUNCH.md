# Launch checklist (roadmap 5.4)

Everything below is a decision or a secret that the code cannot provide. Phases
1–4 are complete; this is the operational work to take the app live.

## 1. Deployment

- [ ] Create the host account and decide **static host vs edge host** (the app
      is a static bundle; any static host or edge CDN can serve it — see
      `docs/STACK_DECISION.md` §13).
- [ ] Add the deploy credentials as repository secrets for the workflow in
      `.github/workflows/deploy.yml` (names depend on the chosen host).
- [ ] Confirm SPA fallback to `index.html` so deep links work.
- [ ] Confirm security headers are actually applied by the host: CSP (including
      `frame-ancestors`), `COOP`, `COEP: credentialless`, HSTS, and immutable
      caching for hashed assets. `public/_headers` carries the intended policy
      for hosts that support that file; other hosts need the equivalent config.
- [ ] Decide repository visibility. It is currently **private**.

## 2. First-run verification (needs real credentials)

- [ ] Add a connection and confirm the connection test passes.
- [ ] Confirm the bucket CORS verdict in the wizard; apply the recommended rule
      if it reports a problem (Phase 5.1).
- [ ] Run the transfer integrity suite: `bun run test:integrity`
      (single-PUT, multipart + composite ETag, parallel parts, resume, ranges).
- [ ] Run the engine benchmark: `bun run bench` (results in
      `benchmarks/ENGINE.md`).
- [ ] Exercise an upload larger than 32 MB to cross the multipart threshold,
      then pause, cancel and resume it.
- [ ] Confirm a dual-pane save writes into a mounted local folder.

## 3. Production checklist

- [ ] Service worker caches the app shell only; verify S3 traffic is never
      cached and that updates are picked up after a deploy.
- [ ] Test in Safari/Firefox: expect the read-only local-folder fallback and
      IndexedDB persistence, and no OPFS-AHP database (Safari's sync-access
      handle cap).
- [ ] Decide whether to ship a `Content-Security-Policy` report endpoint.
- [ ] Consider exporting the vault-recovery guidance to the README (currently
      covered by the "Known Limitations" table).

## 4. Open engineering items (not blocking launch)

- [ ] Evaluate `s3-lite-client` against the vendored `aws4fetch` + custom
      multipart engine (spike from `docs/STACK_DECISION.md` §12).
- [ ] Galeon/Cyberduck comparison numbers for the benchmark table
      (needs a desktop machine).
- [ ] Persistent `FileSystemDirectoryHandle` storage in IndexedDB so the
      mounted folder survives a reload.
- [ ] Background transfer continuation (requires the Background Fetch API,
      currently Chromium-only and service-worker-gated).
