# Running Galiot

> Operator guide. Galiot is self-hosted: the server signs every S3 request and
> opens the connection. The browser only talks to that server.

---

## 1. What you are running

One Bun process serves the web app and the S3 API on the same origin. There is
no platform function, no Cloudflare Worker, no Vercel deploy step. A static file
host cannot run Galiot, because nothing would call S3.

```bash
bun install
bun run dev                      # development, http://127.0.0.1:5173
bun run build && bun run server  # production, serves dist/ and /api/s3
```

Container: build the `Dockerfile`, run it with `GALIOT_HOST=0.0.0.0` (already set
in the image) and a gate (below).

| Variable | Meaning |
|---|---|
| `GALIOT_HOST` | Listen address. Default `127.0.0.1`. |
| `GALIOT_PORT` | Listen port. Default `8788`. |
| `GALIOT_PROXY_TOKEN` / `GALIOT_GATE` | Access gate for a non-loopback bind. Not an S3 key. |
| `GALIOT_PROXY_OPEN` / `GALIOT_GATE_OPEN` | Set to `1` to accept an unauthenticated public bind. Only if you understand what that exposes. |

A non-loopback bind refuses to start without a gate. On loopback no gate is
needed, because only this machine can reach the listener.

## 2. The host must reach the bucket

This is the whole point of the architecture, and the most common failure.

- The machine running Galiot must resolve the endpoint's hostname and open a
  TCP connection to its port. A bucket that is only routable from a laptop VPN
  is unreachable from a server that is not on that VPN.
- Private LAN addresses (`10.x`, `192.168.x`, `127.0.0.1`) are allowed.
  Link-local and cloud-metadata addresses (`169.254.x`, `0.0.0.0`, the IPv6
  metadata address) are refused, as are non-HTTP schemes and URLs with embedded
  credentials.
- TLS is always verified. There is no "skip verification" switch. For a private
  certificate authority, install that CA into the trust store of the host
  running Galiot; do not paste certificates into the connection form.
- Most MinIO and on-premises gateways need **path-style addressing** (Advanced
  settings in the connection form). The connection test turns it on
  automatically when the endpoint is an IP address.

If a connection fails, the message says whether the server could not reach the
endpoint or the bucket refused the request. Bucket CORS is not involved in
either case: the browser never calls S3.

## 3. Where credentials live

- At rest: sealed in the browser vault (AES-GCM-256, key derived from your
  master password). The server never stores them.
- In use: the vault worker sends them to your own server once per session. The
  server keeps them in memory, wipes them when the vault locks or the session
  idles out (15 minutes), and never writes them to disk.
- The access gate is separate from S3 credentials. It protects the server API
  on a public bind; it is not a key and grants nothing in S3.

## 4. Which network each feature uses

| Feature | Network path |
|---|---|
| List, search, folder sizes | Galiot server → S3 |
| Upload, download, resume | browser → Galiot server → S3 |
| Edit, preview (image/PDF/audio/video) | Galiot server → S3 |
| Rename, move, copy, new folder | inside S3 (`CopyObject` / `UploadPartCopy`); bytes never pass through the browser |
| Object versions (list, restore, download, purge) | Galiot server → S3; restore is a server-side copy of the old version onto the key |
| Whole-bucket search | Galiot server walks the bucket (capped at 50,000 keys / 500 matches) |
| Share link, "Through this server" | recipient → Galiot server → S3 |
| Share link, "Direct S3" (presigned) | recipient → S3 directly |
| Upload link, "Through this server" | recipient → Galiot server → S3; one key, byte cap, expiry, revocable |
| Upload link, "Direct S3" (presigned PUT) | recipient → S3 directly |

A server share link works for people who cannot reach S3 themselves, and can be
revoked in the share dialog: the grant is deleted and the URL stops working at
once. An issued link keeps its own expiring credential snapshot in server
memory, so it survives the operator locking the vault; it dies at its expiry,
at revocation, or at server restart. A presigned S3 link cannot be revoked; it
stays valid until it expires, and the recipient must be able to reach the
bucket.

Upload links through the server accept a single PUT to exactly one key, up to
the byte cap chosen at creation (10 MiB / 100 MiB / 1 GiB), until they expire
or are revoked. Content-Length is required; oversized bodies are refused with
413. The recipient needs no credentials and no route to S3 — e.g.
`curl -X PUT --data-binary @file <url>`.

## 5. Limits worth knowing

- Single-request copy is limited to 5 GiB by S3. Larger objects are copied with
  multipart `UploadPartCopy`, still entirely inside S3.
- Rename/move/copy of a folder walks at most 10,000 objects and refuses beyond
  that, so one click cannot run away on a huge prefix.
- The in-browser editor opens text files up to 2 MB. Larger files: download.
- Uploads are multipart with a part ledger, so a paused or interrupted transfer
  resumes from the parts S3 already acknowledged.

## 6. Moving connections between people

Three different tools, three different trust levels:

- **Share connection** (card action): secret-free JSON — endpoint, bucket,
  region, addressing, screened headers. No keys. The recipient imports it
  ("Import connection") and types their own credentials. A file that contains
  credential fields is refused on import.
- **Vault backup / restore** (Vault settings): the whole vault as ciphertext,
  including sealed keys. Restoring needs the backup's master password. This is
  the only supported way to move keys between machines or people.
- **Import from Galeon**: reads a Galeon profile export with credentials and
  seals them into this vault.

There is deliberately no "share connection with keys" button: handing someone
a working key is a credential decision, not a convenience feature, and the
vault backup already covers it with a password boundary.

## 7. Verifying against a real S3 server

The unit suites stub the upstream transport. Two live suites run against a real
S3 implementation that validates signatures independently:

```bash
GALIOT_S3_KEY=galiotadmin GALIOT_S3_SECRET="$(openssl rand -hex 16)" ./scripts/live-s3-test.sh
```

It starts Zenko CloudServer (Scality) in a container, then runs the byte-integrity
suite and the server-path suite (sessions, multipart parts, range downloads,
copy/rename, share read and revoke). The credential is generated per run and
never stored.

MinIO is no longer publicly pullable as of 2026-11 (quay.io answers 401, Docker
Hub denies; upstream archived 2026-04-25). `scripts/minio-test.sh` still works
for operators who hold cached MinIO images, and adds the MinIO-quirk protocol
suite.

### Against a real AWS S3 bucket

With the AWS CLI authenticated (`aws configure`, `aws login`, or SSO), run the
same server-path suite against a throwaway bucket. Export the profile's
credentials into your shell with the CLI's `export-credentials` command in
`env-no-export` format and `eval` (it prints nothing), then map the three
exported AWS values onto `GALIOT_S3_KEY`, `GALIOT_S3_SECRET`, and
`GALIOT_S3_STS` using the same indirect-export loop as
`scripts/live-s3-test.sh`. The credential never appears in chat or in a file.

```bash
REGION=us-east-1                      # or your bucket's region
BUCKET=galiot-live-$(openssl rand -hex 4)
aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
  $( [ "$REGION" = us-east-1 ] || echo --create-bucket-configuration LocationConstraint=$REGION )

GALIOT_S3_ENDPOINT="https://s3.$REGION.amazonaws.com" \
GALIOT_S3_BUCKET="$BUCKET" \
GALIOT_S3_REGION="$REGION" \
bun run test:minio-server
```

The suite enables versioning on the bucket, so cleanup must remove versions and
delete markers, not just current objects:

```bash
aws s3 rm "s3://$BUCKET" --recursive
for kind in Versions DeleteMarkers; do
  aws s3api list-object-versions --bucket "$BUCKET" \
    --query "$kind[].[Key,VersionId]" --output text |
  while IFS=$'\t' read -r key ver; do
    [ -n "$key" ] && aws s3api delete-object --bucket "$BUCKET" --key "$key" --version-id "$ver"
  done
done
aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
```

Expect a few hundred requests at most; cost is negligible, and the bucket is
deleted afterwards. Use a profile whose account you intend to test in.

This procedure was run against real AWS S3 (us-east-1) on 2026-11-17 with
temporary credentials: 26/26 server-path checks passed, and the throwaway
bucket was deleted afterwards. If the key lacks `s3:PutBucketVersioning`, the
versioning checks skip with an explanation rather than failing.

## 8. Provider notes: Dell ECS / ObjectScale

Galiot speaks the S3 protocol, and ECS exposes an S3-compatible API, so ECS
buckets work through the same server path. What to set:

- **Endpoint and port.** Dell's default port table lists S3 on HTTP 9020 and
  HTTPS 9021. Use `https://<ecs-host>:9021` (or your load balancer's port).
- **Path-style addressing: on.** ECS is a path-style vendor; virtual-hosted
  bucket subdomains generally do not resolve. IP endpoints turn it on
  automatically.
- **Namespace.** ECS buckets live in a namespace. If your endpoint does not
  encode it, add `x-emc-namespace: <namespace>` under Advanced settings →
  custom headers. It is a routing header, not a secret, so it is allowed there.
- **Region.** Galiot never calls `GetBucketLocation`, which Dell's S3 support
  matrix lists as unsupported. Type the region your ECS namespace signs with
  (commonly `us-east-1`); a wrong region shows up as `SignatureDoesNotMatch`.
- **Older gateways.** ECS-family systems (including ViPR-era ones) may implement
  only ListObjects v1. Galiot detects the refusal and falls back to v1 marker
  paging for the rest of the session, automatically.
- **CORS and preflight.** Irrelevant here: the server calls S3, so a gateway
  with no CORS API (or no preflight at all) still works.
- **Retention.** Objects under ECS compliance retention refuse overwrite and
  delete. That refusal is the storage system enforcing policy, not a Galiot
  fault; the S3 error code is shown as-is. Where the provider sends Object Lock
  headers, Details shows mode / retain-until / legal hold, and Galiot refuses
  single-object delete, rename, and copy-over early with the date instead of
  forwarding a doomed request.
- **TLS.** Private ECS certificates belong in the trust store of the host
  running Galiot. There is no skip-verification switch.

Verified against: Zenko CloudServer, real AWS S3 (§27 of the decision log),
and — on 2026-11-17 — a live on-premises ECS dev gateway in **scoped mode**
(`GALIOT_LIVE_SCOPED=1`): 20/20 checks, with every object read and write inside
a fresh test prefix that was deleted afterwards, and no bucket-level change.
Two behaviours observed there are permission boundaries, not defects:
`ListBuckets` answers `AccessDenied` for a bucket-scoped key (the suite skips
that check with the code), and versioning checks are skipped in scoped mode
because the bucket's configuration belongs to its owner.

Scoped mode exists for exactly this situation: testing against a bucket that
belongs to another project. It confines the suite to its own prefix, skips
bucket-level configuration, and cleans up only that prefix.

Sources: Dell EMC ECS default port table and S3 guidance via the Kemp ECS
Connection Manager deployment guide
(https://docs.progress.com/bundle/ecs-connection-manager-deployment-guide-kemp-ecs-connection-manager-ga/page/hqi1696458877261.html);
path-style requirement for ECS/ObjectScale per Starburst's Dell object storage
connector documentation
(https://starburstdata.github.io/latest/connector/starburst-dell-object-storage.html).

## 9. What Galiot is not

- Not a multi-protocol client. S3 only.
- Not an object-storage admin console: no users, policies, lifecycle rules, or
  replication management. Use your provider's tools for those.
- Not a hosted service. You run it, you reach the bucket, you hold the keys.
