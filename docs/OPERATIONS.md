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
in the image) and a gate (below). The image carries a HEALTHCHECK against
`/api/health`. Its build context allowlists application inputs, including each
published asset in `public/`. The runtime stage copies the built SPA, bundled
server and license. [Docker build contexts](https://docs.docker.com/build/concepts/context/#dockerignore-files)
· [Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)

Prebuilt images are published to GHCR on version tags
(`ghcr.io/fiztoz/galiot`). An example compose file lives at
`deploy/compose.example.yml`:

```bash
GALIOT_GATE=$(openssl rand -hex 24) docker compose -f deploy/compose.example.yml up -d
```

There is no server-side state and no volume: credentials live in each user's
browser vault; server sessions are memory-only.

| Variable | Meaning |
|---|---|
| `GALIOT_HOST` | Listen address. Default `127.0.0.1`. |
| `GALIOT_PORT` | Listen port. Default `8788`. |
| `GALIOT_PROXY_TOKEN` / `GALIOT_GATE` | Access gate for a non-loopback bind. Not an S3 key. |
| `GALIOT_PROXY_OPEN` / `GALIOT_GATE_OPEN` | Set to `1` to accept an unauthenticated public bind. Only if you understand what that exposes. |
| `GALIOT_PUBLIC_ORIGINS` | Comma-separated browser origins for gate-free controls behind a reverse proxy, e.g. `https://galiot.example.com`. Preserve the public Host header. Direct connections to loopback, or to an IP address on an explicitly open listener, work without this setting. |
| `GALIOT_BRAND_NAME` | White-label display name, max 64 characters. Default `Galiot`. |
| `GALIOT_BRAND_TAGLINE` | Browser-title tagline, max 96 characters. Unset keeps `The Agile Cloud Explorer`; an empty string removes it. |
| `GALIOT_BRAND_LOGO` | Path to a logo image file (svg, png, jpg, jpeg, webp, gif, ico; ≤1 MiB), served same-origin at `/branding/logo`. |
| `GALIOT_PRESET_ENDPOINT` | Pre-fills the endpoint field for new connections, e.g. `https://s3.example.com`. Screened at startup like a live target. |
| `GALIOT_PRESET_REGION` | Pre-fills the region field. Empty keeps `us-east-1`. |
| `GALIOT_PRESET_PATH_STYLE` | `1` starts new connections with path-style addressing (most on-premises gateways). |
| `GALIOT_S3_CONDITIONS` | JSON map of private gateway bucket URLs to verified conditional operations. See below. |

A non-loopback bind refuses to start without a gate. On loopback no gate is
needed, because only this machine can reach the listener.

### Conditional saves and moves

Standard AWS S3 general-purpose buckets on HTTPS service endpoints support saving with the ETag read by the editor and moving with conditional source deletion. [AWS S3 endpoints](https://docs.aws.amazon.com/general/latest/gr/s3.html) · [Conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) · [DeleteObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html)

For a private gateway, turn on **Verify editor saves automatically** when adding or editing a connection. Galiot stores this preference in the local vault database. On a successful bucket listing, the server starts a background check on one random object under `.galiot-editor-check/`. It verifies that PutObject rejects a mismatched ETag, accepts a matching ETag, and returns the expected data, then removes the test object and any versions the gateway reports. It needs permission to create, read, and delete the test object (including its versions if applicable). Retention, versioning, or a dropped connection can leave test data behind. Failed checks leave the editor read-only. Results are cached for ten minutes in the server session; vault lock, session expiration, and server restart discard them. The preference is local and is not transferred when sharing or importing a connection.

The automatic test covers editor saves only. Operators can still certify each operation manually after verifying that a stale ETag is rejected and the original object survives. The server-path integration suite in section 7 checks this on temporary keys. By default a move stops before copying. Ordinary copy remains available.

```bash
export GALIOT_S3_CONDITIONS='{"https://s3.example.com/archive/":["put","move"]}'
```

Use the exact bucket-root URL including addressing style, gateway path, port and trailing slash. A virtual-hosted bucket at the domain root uses `https://archive.s3.example.com/`. Enable `put` for verified PutObject If-Match. Enable `move` after verifying CopyObject and UploadPartCopy source If-Match and DeleteObject If-Match. Apply the setting to the server process and repeat verification after gateway or proxy changes.

Connections with custom request headers keep the read-only editor and copy-only behavior because the same URL may route to a different provider or tenant. When a move copies a versioned source, Galiot retains all sources and reports the copy outcome. Review version history before deleting. A later version can have the same ETag as the copied one.

Copying an object larger than 5 GiB uses multiple requests. For mutable source versions, `copy` enables multipart copies after the gateway has demonstrated copy-source precondition enforcement. The `move` setting includes this capability. An immutable version ID also allows Galiot to read every part from the same revision.

### Custom name and logo (white-label)

A deployment can carry its own name and logo without rebuilding the image.
The server injects the brand into the page title, favicon, PWA manifest and
UI at startup. Restart the process (or roll the pods) to apply changes.

```bash
GALIOT_BRAND_NAME="Acme Explorer" \
GALIOT_BRAND_TAGLINE="Company object storage" \
GALIOT_BRAND_LOGO=/etc/galiot/logo.svg \
bun run server
```

With Helm, set `branding.name`, `branding.tagline`, and either an inline
`branding.logo.svg` or `branding.logo.existingConfigMap`:

```bash
kubectl create configmap acme-logo --from-file=logo.png=./logo.png
helm install galiot deploy/helm/galiot \
  --set gate.value="$(openssl rand -hex 24)" \
  --set branding.name="Acme Explorer" \
  --set branding.logo.existingConfigMap=acme-logo \
  --set branding.logo.key=logo.png
```

- Nothing set means the default Galiot look, unchanged.
- An unreadable, empty, oversized, or wrong-type logo file refuses startup —
  a typo surfaces immediately instead of serving a broken brand.
- An operator-supplied SVG is served with a sandbox CSP, so opening it
  directly as a page cannot run scripts.
- The dev server (`bun run dev`) always shows the default brand; branding is
  applied by the self-hosted server.

### Preset connection defaults

A company deployment can pre-fill the **Add connection** form with its own S3
endpoint, so users start from the corporate gateway instead of an empty field:

```bash
GALIOT_PRESET_ENDPOINT="https://s3.example.com" \
GALIOT_PRESET_REGION="eu-central-1" \
GALIOT_PRESET_PATH_STYLE=1 \
bun run server
```

With Helm: `--set preset.endpoint=https://s3.example.com`
`--set preset.region=eu-central-1` `--set preset.pathStyle=true`.

- Presets are a convenience, not a policy: every field stays editable, and
  presets never contain credentials. Users still bring their own keys.
- The endpoint is screened at startup with the same rules as a live
  connection target (absolute http/https URL, no embedded credentials, no
  link-local/metadata addresses). A bad value refuses startup.
- Existing connections and user drafts are never overwritten; presets apply
  to new connection forms only.

### Kubernetes (Helm)

A chart lives at `deploy/helm/galiot`: one Deployment + Service, optional
Ingress, NetworkPolicy and PodDisruptionBudget. Install with a gate — the
server refuses a non-loopback bind without one, and the chart fails the render
the same way:

```bash
helm install galiot deploy/helm/galiot \
  --set gate.value="$(openssl rand -hex 24)"

# or bring your own Secret (preferred in production):
kubectl create secret generic galiot-gate \
  --from-literal=gate="$(openssl rand -hex 24)"
helm install galiot deploy/helm/galiot --set gate.existingSecret=galiot-gate

kubectl port-forward svc/galiot 8788:8788   # then open http://127.0.0.1:8788
```

Released charts are published to GHCR as OCI artifacts (`chart-v*` tags), so
you can also install without cloning the repo. Set `CHART_VERSION` to the
published chart version you intend to install.

```bash
helm install galiot oci://ghcr.io/fiztoz/charts/galiot --version "$CHART_VERSION" \
  --set gate.value="$(openssl rand -hex 24)"
```

Enter the gate in the app's **Server access** panel. The chart requires a
boolean for `gate.open`. Leave it at `false` when using a token.

- **Schedule downtime for pod replacements.** A revocation has to reach the pod
  that issued the link. The chart accepts one replica, or zero for maintenance.
  A `Recreate` rollout stops the old pod before starting the new one. The service
  is unavailable until the replacement is ready. Active transfers can be
  interrupted, and stopping the pod ends its sessions and through-server links.
  Reconnect and issue fresh links as needed. Scale capacity with `resources`.
  [Kubernetes Deployment strategies](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#recreate-deployment)
- **Allow DNS and the S3 endpoint** (§2). Enabling `networkPolicy.enabled`
  creates an ingress-only policy by default. Upgrading removes the old chart's
  allow-all egress rule. Check existing cluster policies for DNS and S3 access.
  To manage outbound traffic in the chart, set `networkPolicy.egress` to a list
  of rules. An empty list grants no outbound access through this policy.
  [Chart example](../deploy/helm/galiot/README.md#networkpolicy) · [Kubernetes NetworkPolicies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- **Ingress:** terminate TLS there. The server emits HSTS only when the request
  is HTTPS or carries `X-Forwarded-Proto: https`. Uploads stream through the
  server (up to 1 GiB per object), so raise the proxy body limit — for nginx:
  `nginx.ingress.kubernetes.io/proxy-body-size: "0"`.
- **Gateway API:** instead of (or alongside) Ingress, set `gateway.enabled=true`
  with `gateway.parentRefs` naming your Gateway; the chart renders an
  `HTTPRoute` (standard-channel CRDs must be installed). Cross-namespace
  attachment needs `gateway.referenceGrant` — the grant is created in the
  Gateway's namespace. TLS lives on the Gateway listener. Details and an
  example: `deploy/helm/galiot/README.md`.
- **Private CAs:** a container does not inherit the node's trust store. Build
  a derived image that installs your CA into its trust store and point
  `image.repository` at it.
- **Probes** use `/api/health`, which needs no gate and never calls S3.
- Pods run as non-root uid 1000 with a read-only root filesystem; the listen
  port must be ≥1024.

Verify the chart offline (lint, render matrix, strict schema checks), or end
to end against the current kubectl context — `--live` installs into a scratch
namespace, proves health + gate over HTTP, runs `helm test`, and tears down:

```bash
bash scripts/helm-check.sh
bash scripts/helm-check.sh --live
```

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
or are revoked. The server requires Content-Length and rejects oversized bodies
with 413 before consuming the link. Once it forwards a PUT, an interrupted or
failed upload needs a new link. The recipient can upload directly with
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
  region and addressing. The sender may opt in to including screened routing
  headers after checking their values. The recipient imports it
  ("Import connection") and types their own credentials. A file that contains
  credential fields is refused on import.
- **Vault backup / restore** encrypts and authenticates connection settings and
  sealed credentials. Restoring requires the backup's master password. When
  restoring a version 1 backup, review each connection destination before
  confirming. That format stored settings outside the authenticated ciphertext.
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
