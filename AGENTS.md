# Galiot — Agent & Contributor Conventions

> *Guidelines for AI agents and human contributors working on Galiot.*

---

## Project Identity

- **Name**: Galiot — The Agile Cloud Explorer
- **Architecture**: Self-hosted SPA plus a provider-neutral Bun server. The server signs S3 requests and opens the connection. The browser talks only to that server. Not a Cloudflare Worker or a Vercel function.
- **Hosting**: The operator runs Bun or the container (`bun run server`) on a machine that can reach the S3 endpoint. A static file host cannot connect to S3.
- **License**: MIT

## Tech Stack (Canonical Source: `docs/STACK_DECISION.md`)

| Layer | Choice |
|---|---|
| Language | TypeScript ^7.0 (Go-based compiler) |
| UI | React ^19.3 SPA (no SSR/RSC) |
| Bundler | Vite 8 (executed by Bun) |
| Runner/PM | Bun ≥ 1.4.2 |
| Styling | Tailwind CSS ^4.3 |
| Editor | CodeMirror 6 (NOT Monaco) |
| Database | PGlite ≥ 0.5.8 (Postgres 18.3 WASM), IDB VFS primary |
| S3 Signing | Vendored aws4fetch, used by the self-hosted server |
| Vault | WebCrypto AES-GCM-256 + PBKDF2-600k |
| Icons | Lucide React |

## Conventions

### Code Style
- Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`)
- Functional React components only (no class components)
- Named exports (no default exports except route pages)
- Barrel files (`index.ts`) only at module boundaries, not within

### Security Rules
- **Never** expose raw S3 secret keys to the main thread
- The vault worker may send credentials to the same-origin server for a session. The server keeps them in memory and signs there.
- All vault crypto operations in Web Workers only
- Memory zeroing (`buffer.fill(0)`) after sensitive operations
- No `eval`, no `new Function`, no inline scripts
- No external CDN resources — everything vendored

### File Naming
- Components: `PascalCase.tsx`
- Utilities/hooks: `camelCase.ts`
- Workers: `name.worker.ts`
- Tests: `name.test.ts` (colocated)

### Documentation
- Do NOT edit original spec docs retroactively
- Add correction layers via `STACK_DECISION.md` re-verification logs
- All claims must cite sources (vendor docs, npm, MDN)

### Hostnames
- **Never** put a real customer, third-party or internal hostname in code, tests or docs — not even in a comment explaining a bug that a real endpoint revealed
- Use RFC 2606 reserved names instead (`example.com`, `s3.example.com`, `bucket.example.com`), or loopback/private addresses (`localhost`, `127.0.0.1`, `10.0.0.5`)
- Describe the affected system generically ("an on-premises S3 gateway", "a corporate MinIO")
- `src/repoHostnames.test.ts` enforces this for `src/`

### Commit Messages
- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`
- Reference component: `feat(vault): add export/import backup`
