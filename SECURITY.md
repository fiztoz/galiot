# Security Policy

Galiot is a self-hosted web client for S3. It holds credentials, so report
problems privately rather than in public issues.

## Reporting a vulnerability

- Use **Report a vulnerability** in the **Security** tab of this repository
  (GitHub private security advisory); it opens a private thread with the
  maintainers.
- **Do not** open a public issue, pull request or discussion for a vulnerability.
- Include what you did, what happened and what you expected. A proof of concept is
  welcome — real credentials and real hostnames are not.
- There is **no bug bounty**. This is a small MIT project.
- Coordinated disclosure is appreciated: give us a reasonable window to ship a fix
  before publishing; we will credit you unless you ask otherwise.

Please redact secrets and substitute RFC 2606 names (`example.com`,
`s3.example.com`) for any endpoint that is not yours.

## Supported versions

Only the `main` branch and the latest tagged release are supported. Fixes land on
`main`; older commits are unmaintained and security backports are not offered.

## Trust model (read this before deploying)

Galiot is **not** zero-knowledge while a session is open. The operator of the
Galiot server is trusted with the S3 credentials of anyone using it.

**What the server operator can see**

- The S3 access key and, for the length of a session, the secret key — in process
  memory. The vault worker sends them once per session so the server can sign
  requests; the server wipes them when the vault locks or the session idles out
  (15 minutes) and never writes them to disk.
- **All S3 traffic**: every list, transfer, preview, edit and copy goes through
  the server, which can read, log or alter it. Rename, move and copy run inside
  S3, but the server still issues those requests.
- Because it signs on demand, it can act with those keys while it holds them.

**What stays client-side**

- The vault at rest: ciphertext sealed with AES-GCM-256 under a PBKDF2-derived
  key (600k iterations), stored in the browser. The server never receives the
  vault or its ciphertext blob.
- The data-encryption key (DEK), which only the vault worker unwraps in memory.
  Losing the passphrase and the exported backup makes the vault unrecoverable.

**Access gate**

A bind to any non-loopback interface refuses to start unless
`GALIOT_PROXY_TOKEN` or `GALIOT_GATE` is set. `GALIOT_PROXY_OPEN=1` (or
`GALIOT_GATE_OPEN=1`) deliberately disables that check and exposes an
unauthenticated S3-signing API. The gate protects this server only — it is not
an S3 credential and grants nothing in the bucket.

**Share-grant bounds**

- Server-streamed share and upload links are revocable: deleting the grant stops
  the URL immediately, and the URL dies at its expiry or on server restart.
- Upload links through the server accept one PUT to one fixed key, up to the byte
  cap chosen at creation (10 MiB / 100 MiB / 1 GiB) and refused with `413` above
  it; `Content-Length` is required.
- A share grant keeps its own expiring credential snapshot in server memory, so
  it survives the operator locking the vault; that snapshot is delegated
  authority for the grant's lifetime.
- Preview grants (the same-origin media URLs behind image/PDF/audio/video
  previews and type sniffing) are bound to the issuing session: they are wiped
  when the vault locks or the session closes, and the preview hands its grant
  back as soon as the pane closes or the sniff sample is read.

**Known boundaries**

- **Presigned ("Direct S3") links cannot be revoked.** A presigned URL is a
  self-contained bearer token; it stays valid until it expires. Prefer the
  server-streamed grant when revocation matters.
- **TLS is always verified.** There is no skip-verification switch; a private or
  self-signed CA belongs in the trust store of the host running Galiot, not
  pasted into a connection.
- Stored credentials are only as safe as that machine's browser profile and
  vault passphrase. Export a vault backup before wiping a browser.