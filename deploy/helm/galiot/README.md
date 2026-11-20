# Galiot Helm chart

Deploys [Galiot](https://github.com/fiztoz/galiot) — a self-hosted S3 file
browser — as one Deployment + Service. The Bun server serves the SPA and signs
every S3 request, so **the nodes running the pods must be able to reach your S3
endpoint** (DNS, port, TLS). There is no server-side state: no PVC, no database.
Credentials live in each user's browser vault; server sessions are memory-only.

Operator background: [`docs/OPERATIONS.md`](../../../docs/OPERATIONS.md).

## Install

```bash
# Trial: chart-managed Secret (the token is stored in the Helm release record)
helm install galiot deploy/helm/galiot \
  --set gate.value="$(openssl rand -hex 24)"

# Production: bring your own Secret
kubectl create secret generic galiot-gate \
  --from-literal=gate="$(openssl rand -hex 24)"
helm install galiot deploy/helm/galiot \
  --set gate.existingSecret=galiot-gate
```

Released charts are published to GHCR as OCI artifacts (`chart-v*` tags):

```bash
helm install galiot oci://ghcr.io/fiztoz/charts/galiot --version 0.1.1 \
  --set gate.value="$(openssl rand -hex 24)"
```

The gate protects the Galiot API. It is **not** an S3 key. Enter it in the
app's *Server access* panel. A non-loopback bind refuses to start without a
gate, so the chart fails the render when none is configured. `gate.open=true`
explicitly accepts an unauthenticated public bind — dangerous, test networks
only.

Reach the app:

```bash
kubectl port-forward svc/galiot 8788:8788
# open http://127.0.0.1:8788
```

## Keep replicaCount at 1

Sessions and share-link grants live in **one pod's memory** (15-minute session
TTL, 1-hour share grants). With more replicas:

- a share link minted on pod A returns 404 when pod B answers;
- operator sessions bounce between pods (clients retry, transfers degrade).

There is no shared session store, so this chart ships no HPA. Scale vertically
(`resources`) instead.

## Ingress

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "0"     # uploads stream through the server
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
  hosts:
    - host: galiot.example.com   # replace with your hostname
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: galiot-tls
      hosts:
        - galiot.example.com
```

Two server behaviours matter behind a proxy:

- Uploads go through the server (up to 1 GiB per object). nginx's default 1m
  body limit breaks them — set `proxy-body-size` to `0` or a large value.
- The server only emits HSTS when the request is HTTPS or carries
  `X-Forwarded-Proto: https`. Terminate TLS at the ingress and make sure it
  forwards that header (ingress-nginx does by default).

## Private CAs

TLS to S3 is always verified; there is no skip-verify switch. A container does
not inherit the node's trust store. For a private CA, build a derived image
that installs the CA into the image's trust store, and point `image.repository`
at it (see `docs/OPERATIONS.md`).

## Security defaults

- Non-root uid/gid 1000 (the `bun` user in `oven/bun`), `runAsNonRoot`,
  seccomp `RuntimeDefault`, all capabilities dropped, no privilege escalation.
- Read-only root filesystem; `/tmp` is an emptyDir and `HOME=/tmp`.
- Dedicated ServiceAccount with `automountServiceAccountToken: false` — the
  app never talks to the Kubernetes API.
- `service.port` must be ≥1024 (non-root cannot bind privileged ports); the
  render fails otherwise.
- Optional NetworkPolicy (`networkPolicy.enabled`) and PDB (`pdb.create`).
  Egress is left open because the server must reach arbitrary S3 endpoints.

## Verify

```bash
helm lint deploy/helm/galiot
bash scripts/helm-check.sh          # lint + render matrix + negative renders
bash scripts/helm-check.sh --live   # also install into a scratch namespace,
                                    # prove health + gate over HTTP, tear down
helm test galiot                    # in-cluster health + gate wiring check
```

`helm test` runs a pod labeled `app.kubernetes.io/name: galiot-test`. If you
restrict `networkPolicy.ingressFrom`, allow that pod too or the test is blocked.

## Key values

| Value | Default | Meaning |
|---|---|---|
| `replicaCount` | `1` | Keep at 1 — memory-only sessions/share grants |
| `image.repository` / `image.tag` / `image.digest` | `ghcr.io/fiztoz/galiot` / appVersion / `""` | Image; digest wins over tag |
| `gate.value` | `""` | Chart-managed gate Secret |
| `gate.existingSecret` / `gate.existingSecretKey` | `""` / `gate` | Bring-your-own gate Secret |
| `gate.open` | `false` | DANGER: unauthenticated bind |
| `service.port` | `8788` | Service + container listen port (≥1024) |
| `ingress.enabled` | `false` | Ingress with hosts/TLS |
| `networkPolicy.enabled` | `false` | Ingress restriction; egress open |
| `pdb.create` | `false` | PDB; with 1 replica prefer `maxUnavailable: 1` |
| `resources` | 100m/128Mi req, 512Mi limit | No CPU limit by design |
| `extraEnv` / `extraVolumes` / `extraVolumeMounts` | `[]` | Escape hatches |
