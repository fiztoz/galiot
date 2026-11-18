# Galiot — Security Architecture & Threat Model

> **⚠️ Hosting correction (2026-09-24):** the hosting and cost statements in
> this document are obsolete. Galiot's build output is a static bundle that any
> static host or edge CDN can serve; the provider is an interchangeable
> implementation detail, not a design constraint. See
> [docs/STACK_DECISION.md](docs/STACK_DECISION.md) for the decision log. This
> file is kept as the original spec; corrections live there.
>
> **⚠️ Security model correction (2026-11-17):** Galiot is self-hosted: the Bun
> server signs every S3 request itself and holds session credentials **in
> memory** (never at rest). The historical "zero-knowledge server" framing
> below is false for the current model — the vault is zero-knowledge **at
> rest** only. Read "Current security model (2026-11)" immediately below before
> the historical sections. See [docs/OPERATIONS.md](docs/OPERATIONS.md) §3 and
> [docs/STACK_DECISION.md](docs/STACK_DECISION.md) §22.


> *A comprehensive security deep dive for running a 100% client-side, zero-knowledge cloud storage client in the browser and on GitHub Pages.*

---

## Current security model (2026-11)

*Correction layer. The sections below this one are the original spec, kept as
written; where they conflict with this section, this section wins.*

- **Self-hosted, server-side signing.** One Bun process serves the SPA and the
  S3 API on the same origin. The server signs every S3 request (vendored
  aws4fetch) and opens the connection; the browser talks only to same-origin
  `/api/s3` (CSP `connect-src 'self'`). A static host cannot run Galiot.
- **The server sees credentials in memory, per session.** The old
  "zero-knowledge server" claim is false now: the vault worker sends the
  decrypted keys to the operator's own server once per session. The server
  keeps them in memory only, wipes them on vault lock or session expiry
  (15-minute idle), and never writes them to disk.
- **The vault is zero-knowledge at rest.** Credentials are still sealed in the
  browser WebCrypto vault (PBKDF2-600k, AES-GCM-256; the DEK lives only in the
  vault worker; memory zeroing after use) and PGlite stores ciphertext only.
- **CORS (§6) applies only to "Direct S3" presigned links.** Listing,
  transfer, edit, and preview run through the server and need no bucket CORS
  policy. §6's bucket-CORS guidance is relevant only for the explicit presigned
  "Direct S3" share option, whose loads use the recipient's network.
- **Share links:** default are revocable, expiring server-streamed grants;
  upload grants cover one key with a byte cap; presigned S3 URLs are the
  explicit "Direct S3" option and cannot be revoked.

---

## 1. Threat Model & Environment Comparison

Transitioning from a native desktop application (**Galeon**) to a 100% client-side web application (**Galiot**) fundamentally alters the security perimeter:

```
+───────────────────────────────────────────────────────────────────────────────────+
|                           THREAT LANDSCAPE COMPARISON                             |
+───────────────────────────+───────────────────────────+───────────────────────────+
| Security Dimension        | Galeon (Desktop / Tauri)  | Galiot (Web / Browser)    |
+───────────────────────────+───────────────────────────+───────────────────────────+
| Secret Storage            | OS Keyring (macOS/Win/Lin)| No OS Keyring; requires   |
|                           | protected by system login | in-browser zero-knowledge |
|                           | and biometric prompts.    | WebCrypto vault.          |
+───────────────────────────+───────────────────────────+───────────────────────────+
| Memory Isolation          | Isolated process space;   | Shared browser memory;    |
|                           | immune to browser add-ons.| browser extensions can    |
|                           |                           | inject content scripts.   |
+───────────────────────────+───────────────────────────+───────────────────────────+
| Script Injection (XSS)    | CSP in Tauri webview;     | High risk on web; must be |
|                           | no external web origins.  | neutralized via strict    |
|                           |                           | CSP and WASM isolation.   |
+───────────────────────────+───────────────────────────+───────────────────────────+
| Untrusted File Previews   | Spawns isolated local     | Previews render in-tab;   |
|                           | preview apps / OS viewer. | SVG/HTML files can hijack |
|                           |                           | the origin if unsandboxed.|
+───────────────────────────+───────────────────────────+───────────────────────────+
| Network Security          | Raw TCP; no CORS checks.  | Strict CORS preflights;   |
|                           |                           | risk of misconfigured '*'.|
+───────────────────────────+───────────────────────────+───────────────────────────+
```

---

## 2. Credential Security: The Zero-Knowledge Vault

The most critical asset in Galiot is the user's cloud credentials (AWS Access Key ID, Secret Access Key, Session Tokens). In a pure client-side web environment, **storing credentials in plaintext inside `localStorage`, unencrypted `IndexedDB`, or OPFS is an unacceptable vulnerability**.

### 2.1 The Two-Tier Hardware & Master Vault Architecture

Galiot implements a zero-knowledge, client-side encryption vault using the Web Crypto API (`SubtleCrypto`):

```
+─────────────────────────────────────────────────────────────────────────────+
|                         GALIOT ZERO-KNOWLEDGE VAULT                         |
+─────────────────────────────────────────────────────────────────────────────+

  [ User Authentication Ceremony ]
         │
         ├──► OPTION A: WebAuthn Passkey with PRF Extension (Recommended)
         │    Touch ID / Face ID / YubiKey derives hardware-backed 256-bit secret.
         │    (Zero password to type, zero password to crack, hardware-bound).
         │
         └──► OPTION B: Master Passphrase (Fallback)
              Argon2id WASM / PBKDF2 (600,000 iterations) with cryptographic salt.
                      │
                      ▼
         [ 256-bit Key Encryption Key (KEK) ]
                      │
                      ▼ (Unwraps)
         [ Ephemeral Data Encryption Key (DEK) ]  <── Exists only in Web Worker RAM
                      │
                      ▼ (AES-GCM-256)
         [ Encrypted Profile Record in PGlite / OPFS ]
         {
           "id": "uuid-123",
           "endpoint": "https://s3.us-west-004.backblazeb2.com",
           "ciphertext": "a8fbc32...",
           "iv": "d19e34...",
           "tag": "e78b12..."
         }
```

### 2.2 Modern WebAuthn PRF (Pseudo-Random Function) Extension
Galiot leverages the **WebAuthn PRF extension** (WebAuthn Level 3):
- During authentication, the browser requests a deterministic symmetric key from the hardware authenticator (Apple Secure Enclave, Windows Hello, YubiKey).
- The key is derived inside the hardware security chip and is never exposed to GitHub Pages or any network server.
- This gives Galiot **hardware-backed biometric security** equivalent to the desktop macOS Keychain, directly inside the browser.

### 2.3 Ephemeral Key Lifecycle in Memory
1. **Isolated Worker Thread**: Decryption and AWS SigV4 signing happen exclusively inside the dedicated `s3-signer.worker.ts`. The main DOM thread never holds the raw Secret Access Key.
2. **Deterministic Memory Zeroing**: When signing finishes or when the user switches tabs, buffers holding keys are immediately overwritten:
   ```typescript
   // Explicitly wipe sensitive buffers from memory
   secretKeyBuffer.fill(0);
   ```
3. **Auto-Lock Timeout**: An inactivity timer (default 15 minutes) discards the decrypted DEK from memory, requiring biometric or passphrase re-authentication.
4. **Temporary Credentials (STS) Priority**: Galiot strongly encourages users to use short-lived session tokens (via AWS STS `AssumeRole`, lasting 1 to 12 hours) rather than root IAM account keys.

---

## 3. Cross-Site Scripting (XSS) & Content Security Policy (CSP)

In a 100% client-side application, an XSS vulnerability would allow an attacker to execute JavaScript, inspect memory, and exfiltrate credentials.

### 3.1 Hardened Content Security Policy (CSP)
Galiot deploys an uncompromising CSP via `<meta http-equiv="Content-Security-Policy">`:

```http
default-src 'none';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' blob: data: https:;
connect-src 'self' https:;
font-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
```

**Key Directives**:
- `script-src 'self' 'wasm-unsafe-eval'`: Allows execution of Galiot's own static bundle and the compilation of **PGlite WebAssembly**, while strictly blocking all inline `<script>` tags, eval, and third-party remote scripts.
- `object-src 'none'`: Neutralizes Flash, Java applets, and legacy plugin exploits.
- `frame-ancestors 'none'`: Prevents clickjacking by forbidding embedding Galiot inside external iframes.

### 3.2 Origin Isolation on GitHub Pages (`github.io`)
- **Public Suffix List (PSL)**: `github.io` is registered on the global Public Suffix List. This means `alice.github.io` and `bob.github.io` are treated by all modern browsers as **separate, isolated origins**. Alice cannot access Bob's cookies, IndexedDB, or OPFS.
- **Same-User Risk**: If a user hosts another application under the same GitHub account (e.g., `user.github.io/demo-app`), both apps share the `user.github.io` origin.
- **Best Practice Recommendation**: 
  - Host Galiot on a **custom domain** (e.g., `galiot.example.com` or `s3.example.com`), or
  - Dedicate the root `user.github.io` repository exclusively to Galiot.

---

## 4. Defending Against Malicious Browser Extensions

Desktop applications run in isolated OS processes. Web applications run in an environment where the user may have third-party browser extensions installed (e.g., ad blockers, coupon finders, translator tools).

### 4.1 Threat Mechanism
Extensions with broad host permissions (`<all_urls>`) can inject content scripts into web pages. While content scripts run in an "isolated world," they share the same DOM, can observe user keystrokes, and can intercept network calls by monkey-patching `window.fetch`.

### 4.2 Galiot's Defenses:
1. **Web Worker Shield**: Content scripts **cannot** inject into Web Workers. All cryptographic operations, database queries, and S3 SigV4 signature calculations execute strictly inside Web Workers.
2. **Defensive Object Freezing**: On application bootstrap, Galiot freezes critical globals to prevent prototype pollution:
   ```typescript
   Object.freeze(Object.prototype);
   Object.freeze(Array.prototype);
   ```
3. **Private Worker Channels**: Communication between the UI and the worker uses `MessageChannel` with unique private ports rather than broad `window.postMessage` broadcasts.
4. **User Security Guidance**: Galiot provides a status indicator warning users if aggressive content scripts are detected, recommending running sensitive cloud operations in a clean profile or private browsing mode without untrusted extensions.

---

## 5. Untrusted File Previews: Neutralizing Malicious Content

A common attack vector against cloud storage explorers is **stored payload injection**: an attacker uploads a malicious file to an S3 bucket, hoping the administrator will click to preview it inside Galiot.

```
+─────────────────────────────────────────────────────────────────────────────+
|                        FILE PREVIEW SAFETY PIPELINE                         |
+─────────────────────────────────────────────────────────────────────────────+

  Remote S3 File
       │
       ├──► 1. HTML / XHTML / HTM Files:
       │    NEVER rendered as HTML DOM.
       │    Previewed strictly as raw syntax-highlighted source code in Monaco!
       │
       ├──► 2. SVG Vector Images:
       │    Rendered EXCLUSIVELY via HTML <img> tags: <img src="blob:..." />.
       │    Browsers strictly disable all JavaScript execution inside <img> tags.
       │    (Never rendered inline as raw <svg> tags).
       │
       ├──► 3. Media & PDFs:
       │    Streams loaded with explicit Sandboxed Blob MIME-types.
       │    PDFs isolated in an iframe with strict sandbox:
       │    <iframe sandbox="allow-forms" src="..." />
       │    (Omits allow-scripts and allow-same-origin).
       │
       └──► 4. Executables & Binaries (.exe, .dmg, .sh):
            No preview; metadata inspector only with one-click download.
```

---

## 6. S3 CORS Configuration: Preventing Over-Permissive Buckets

To allow Galiot to connect directly from the browser, the target S3 bucket must have a CORS policy.

### 6.1 The Wildcard Vulnerability (`AllowedOrigins: *`)
Many online tutorials instruct users to set `AllowedOrigins: ["*"]` and `AllowedHeaders: ["*"]`. 
- **The Danger**: If an S3 bucket allows `*` as the origin, any malicious website the user visits in another tab could craft cross-origin requests to that bucket if signed URLs or session credentials leak.

### 6.2 Galiot's Hardened CORS Guidance
Galiot includes an interactive CORS validator that rejects wildcard policies and generates strictly scoped policies:

```json
[
  {
    "AllowedOrigins": [
      "https://user.github.io",
      "https://galiot.example.com"
    ],
    "AllowedMethods": [
      "GET",
      "PUT",
      "POST",
      "DELETE",
      "HEAD"
    ],
    "AllowedHeaders": [
      "*"
    ],
    "ExposeHeaders": [
      "ETag",
      "x-amz-request-id",
      "x-amz-id-2",
      "x-amz-meta-*"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

---

## 7. Supply Chain & Dependency Integrity

Because Galiot is hosted as a static bundle on GitHub Pages, ensuring the integrity of the build pipeline is vital:

1. **Deterministic Frozen Lockfiles**: All builds run with `bun install --frozen-lockfile`. No dependency can shift between development and release.
2. **Automated Vulnerability Audits**: Integrated `bun audit` in GitHub Actions CI blocks pull requests with known CVEs.
3. **PGlite WASM Verification**: The compiled PostgreSQL WASM binary is verified via SHA256 checksums before compilation into the distribution bundle.
4. **Subresource Integrity (SRI)**: All bundled assets and scripts deployed to GitHub Pages use cryptographic integrity hashes (`integrity="sha384-..."`).
5. **Zero External CDNs**: 100% of assets (fonts, icons, WASM binaries, Monaco workers) are vendored locally in the repository. Galiot never fetches scripts from third-party CDNs at runtime.

---

## 8. Security Implementation Checklist for Galiot

- [ ] **Cryptographic Vault**:
  - [ ] Implement WebAuthn PRF extension for hardware-backed Passkey encryption.
  - [ ] Implement PBKDF2 (600,000 rounds) fallback with unique per-vault salt.
  - [ ] Use AES-GCM-256 with 96-bit random IVs for every encryption operation.
- [ ] **Memory & Worker Isolation**:
  - [ ] Restrict decrypted secret keys strictly to `s3-signer.worker.ts`.
  - [ ] Implement automatic memory wipe (`buffer.fill(0)`) after SigV4 signing.
  - [ ] Implement 15-minute inactivity auto-lock.
- [ ] **Platform & Origin**:
  - [ ] Deploy strict Content Security Policy (CSP) blocking inline scripts and untrusted domains.
  - [ ] Prevent clickjacking via `frame-ancestors 'none'`.
  - [ ] Recommend custom domain deployment to avoid shared `github.io` origin collision.
- [ ] **Preview Sandboxing**:
  - [ ] Enforce source-code-only Monaco preview for `.html`, `.xml`, and script files.
  - [ ] Render all `.svg` files strictly through HTML `<img>` elements.
  - [ ] Sandbox PDF previews in restricted iframes.
- [ ] **CORS & Permissions**:
  - [ ] Guide users away from `AllowedOrigins: *` in the connection wizard.
  - [ ] Generate scoped IAM policy templates adhering to the principle of least privilege.
