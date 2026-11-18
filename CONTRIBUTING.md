# Contributing to Galiot

Thanks for helping. Galiot is MIT and self-hosted by design: one Bun process
serves the SPA and signs S3 requests — no platform functions, no static-host path.

## Prerequisites

- **Bun >= 1.4.2** (`bun --version`)
- A browser with WebCrypto, Web Workers and OPFS (current Chrome, Edge, Firefox, Safari)
- Optional: Docker (colima or Docker Desktop) for the live S3 suite

## Setup

```bash
bun install
bun run dev                       # http://127.0.0.1:5173, dev proxy included
bun run build && bun run server   # production, serves dist/ and /api/s3 on :8788
```

`bun run server` needs no gate on loopback. A non-loopback bind requires
`GALIOT_PROXY_TOKEN` or `GALIOT_GATE`; see [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Checks that must pass

Run all three before opening a pull request — CI runs exactly these:

```bash
bun run type-check   # tsc --noEmit, strict
bun test             # unit suites, 400+ tests, colocated *.test.ts
bun run build        # vite build; dist/ must contain no .map files
```

A change that only passes by relaxing a type or shipping source maps is not ready.

## Live verification

Unit tests stub the upstream transport, so signing, pagination, multipart, ranges
and grants want a real S3 implementation. Use a **throwaway, ephemeral bucket**
you are willing to destroy — never a shared or production bucket.

```bash
GALIOT_S3_KEY=... GALIOT_S3_SECRET=... ./scripts/live-s3-test.sh
```

That starts Zenko CloudServer in a container, runs the byte-integrity and
server-path suites, then tears it down. The credential is generated per run and
never stored; never paste keys into a commit, a fixture or an issue.

**Testing a bucket you do not own?** Use scoped mode:

```bash
GALIOT_LIVE_SCOPED=1 GALIOT_S3_KEY=... GALIOT_S3_SECRET=... bun run test:minio-server
```

Scoped mode reads and writes only inside a fresh test prefix, skips bucket-level
configuration (versioning, `ListBuckets`), and cleans up only that prefix. Bucket
config belongs to its owner; when you fix a real defect, add a regression test.

## Code conventions

Summarised from [AGENTS.md](AGENTS.md), which is authoritative:

- **Strict TypeScript**: `strict` and `noUncheckedIndexedAccess`. No `any` escape
  hatches to silence an error.
- **Functional React components only**; no class components, no SSR/RSC.
- **Named exports**, except route pages. Barrel `index.ts` files only at module
  boundaries, never inside a module.
- **File naming**: components `PascalCase.tsx`, utilities/hooks `camelCase.ts`,
  workers `name.worker.ts`, tests `name.test.ts` colocated with the source.
- **Security rules, non-negotiable**: never expose raw S3 secret keys to the main
  thread; the vault worker may hand credentials to the same-origin server for a
  session, which keeps them in memory only; all vault crypto runs in Web Workers;
  zero buffers (`buffer.fill(0)`) after sensitive operations; no `eval`, no
  `new Function`, no inline scripts; no external CDN resources — vendor
  everything.

## Hostnames

Never put a real customer, third-party or internal hostname in code, tests, docs
or commit messages — not even in a comment explaining a bug a real endpoint
revealed. Use RFC 2606 names (`example.com`, `s3.example.com`,
`bucket.example.com`), loopback or private addresses (`localhost`, `127.0.0.1`,
`10.0.0.5`), or describe the system generically ("an on-premises S3 gateway").
`src/repoHostnames.test.ts` enforces this for `src/`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/) with a component
scope — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:` — e.g.
`feat(vault): add export/import backup`. One logical change per commit; say what
changed and why in the body when it is not obvious.

## Documentation

- Do **not** rewrite the original specification documents (`ARCHITECTURE.md`,
  `TECH_STACK.md`, `PGLITE_SPEC.md`, `SECURITY_DEEP_DIVE.md`, research passes).
- Add a **correction layer**: a dated re-verification entry in
  [docs/STACK_DECISION.md](docs/STACK_DECISION.md), stating what changed, why, and
  what it supersedes.
- Cite sources for factual claims (vendor docs, npm, MDN) rather than asserting
  from memory.

Vulnerabilities are not public issues — see [SECURITY.md](SECURITY.md).