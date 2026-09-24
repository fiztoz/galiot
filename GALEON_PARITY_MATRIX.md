# Galiot — Galeon Parity Matrix & Web Trade-off Analysis

> **⚠️ Hosting correction (2026-09-24):** the hosting and cost statements in
> this document are obsolete. Galiot's build output is a static bundle that any
> static host or edge CDN can serve; the provider is an interchangeable
> implementation detail, not a design constraint. See
> [docs/STACK_DECISION.md](docs/STACK_DECISION.md) for the decision log. This
> file is kept as the original spec; corrections live there.


> *A feature-by-feature evaluation comparing Galeon (Desktop / Rust / Tauri) with Galiot (100% Client-Side Web / GitHub Pages), detailing parity strategies, web trade-offs, and web-native superpowers.*

---

## 1. Feature Parity Matrix

| Feature / Capability | Galeon (Desktop) | Galiot (Web / GitHub Pages) | Parity Status |
|---|---|---|---|
| **S3 Storage Engine** | Rust OpenDAL | TypeScript S3 Client (Direct REST via fetch) | **100% Full Parity** |
| **S3 Providers (R2, AWS, MinIO, B2)** | All supported | Supported (requires bucket CORS) | **100% Full Parity** |
| **Dual-Pane Mode** | Native `std::fs` | File System Access API (`showDirectoryPicker`) | **Full Parity** (requires user permission) |
| **Parallel Chunked Uploads** | Rust tokio worker pool | Web Worker Pool (S3 Multipart) | **100% Full Parity** |
| **Resumable Transfers** | `.part` files on disk | OPFS temporary chunks + PGlite ledger | **100% Full Parity** |
| **Credentials Storage** | OS Keyring (macOS Keychain, etc.) | WebCrypto AES-GCM-256 Vault | **Adapted for Web** (Zero-knowledge local vault) |
| **File Editing** | Spawns external editor (VS Code, etc.) | Embedded Monaco Editor with diff view | **Enhanced** (In-browser editing & side-by-side diff) |
| **SFTP & FTP/FTPS** | Native Rust (libssh2) | Requires optional Bun companion proxy | **Available via companion** |
| **Presigned URLs** | AWS SDK / OpenDAL signer | Client-side AWS SigV4 Signer | **100% Full Parity** |
| **Keyboard Navigation & ⌘K** | React Hotkeys | React Hotkeys & Command Palette | **100% Full Parity** |
| **Themes (Zinc + Gale Teal)** | Semantic CSS / Tailwind | Semantic CSS / Tailwind | **100% Full Parity** |

---

## 2. Web-Native "Superpowers" in Galiot

By operating as a 100% client-side web application, Galiot gains unique superpowers over traditional desktop clients:

1. **Zero Installation & Zero Gatekeeper Issues**:
   - As documented in Galeon's `AGENTS.md` and `RELEASE_MACOS.md`, desktop macOS builds face Apple Gatekeeper rejection unless notarized. Windows SmartScreen warns on unsigned binaries.
   - **Galiot is instant**: Open a URL on GitHub Pages. It runs immediately on macOS, Windows, Linux, Chromebooks, and iPads with zero friction.
2. **Instant SQL Analytics over Buckets (PGlite)**:
   - Galiot runs real PostgreSQL in the browser. You can run complex SQL queries, sort by size, filter by date ranges, or execute full-text regex searches across hundreds of thousands of keys instantly.
3. **Side-by-Side In-Browser Visual Diff**:
   - Rather than blindly overwriting remote files after editing in an external program, Galiot shows a split diff of your edits before committing them to S3.
4. **$0 Infrastructure & Hosting**:
   - Hosted permanently for free on GitHub Pages.
