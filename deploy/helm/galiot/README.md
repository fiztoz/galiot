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

Released charts are published to GHCR as OCI artifacts (`chart-v*` tags).
Set `CHART_VERSION` to the published version you intend to install.

```bash
helm install galiot oci://ghcr.io/fiztoz/charts/galiot --version "$CHART_VERSION" \
  --set gate.value="$(openssl rand -hex 24)"
```

The gate protects the Galiot API. It is **not** an S3 key. Enter it in the
app's *Server access* panel. A non-loopback bind refuses to start without a
gate, so the chart fails the render when none is configured. `gate.open=true`
explicitly accepts an unauthenticated public bind — dangerous, test networks
only. Supply a YAML boolean or use `--set gate.open=true`. Quoted strings
and numbers fail the render.

Reach the app:

```bash
kubectl port-forward svc/galiot 8788:8788
# open http://127.0.0.1:8788
```

## Upgrades and downtime

The chart accepts one serving replica, or zero for maintenance. Sessions,
share grants and revocations live in the issuing pod. Keep a single issuer
behind the Service and scale capacity with `resources`.

During a pod-template upgrade, `Recreate` waits for the old pod to terminate
before starting its replacement. Schedule downtime until the replacement is
ready. Active transfers can be interrupted. Reconnect and reissue any
through-server links that recipients still need. Direct S3 presigned links
retain their original expiry. For a planned restart, use
`kubectl rollout restart deployment/<name>`. Manually deleting a pod can
start its replacement while the old pod is terminating.
[Kubernetes Deployment strategies](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#recreate-deployment)

## Custom name and logo (white-label)

```yaml
branding:
  name: Acme Explorer
  tagline: Company object storage
  logo:
    svg: '<svg viewBox="0 0 32 32">…</svg>'   # inline SVG, chart-managed ConfigMap
    # — or —
    existingConfigMap: acme-logo               # kubectl create configmap acme-logo --from-file=logo.png=./logo.png
    key: logo.png
```

The server injects the brand into the title, favicon, PWA manifest and UI at
startup — no image rebuild. Logo files: svg/png/jpg/jpeg/webp/gif/ico, ≤1 MiB;
bad files refuse startup. A pod restart applies changes (`helm upgrade` rolls
them; chart-managed logos roll automatically via checksum). See
`docs/OPERATIONS.md` for the plain-env form.

## Preset connection defaults

```yaml
preset:
  endpoint: https://s3.example.com   # your company S3 gateway
  region: eu-central-1
  pathStyle: true                    # most on-premises gateways need this
```

New "Add connection" forms start pre-filled; fields stay editable and no
credentials are preset. The endpoint is screened at startup (http/https, no
embedded credentials, no metadata addresses) — a bad value refuses the pod.
Existing connections and drafts are untouched.

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

In open mode (`gate.open: true`), the chart sets `GALIOT_PUBLIC_ORIGINS`
from the concrete hostnames in the enabled Ingress. Each host gets HTTPS
when it matches an `ingress.tls[].hosts` entry and HTTP otherwise. For the
example above, the generated value is `https://galiot.example.com`.
A TLS wildcard covers one DNS label. [Kubernetes Ingress hostnames](https://kubernetes.io/docs/concepts/services-networking/ingress/#hostname-wildcards)

For a wildcard or hostless route, a Gateway, an external proxy, or a public
port other than 80 for HTTP or 443 for HTTPS, set the complete list of browser
origins in `extraEnv`. This entry replaces the inferred list and also accepts
`valueFrom`. Use comma-separated absolute HTTP or HTTPS origins with the port
users visit. Configure the proxy to preserve the public `Host` header,
including any non-default port. Loopback and literal IP access work without
an entry.

```yaml
extraEnv:
  - name: GALIOT_PUBLIC_ORIGINS
    value: "https://galiot.example.com,https://files.example.com:8443"
```

Two server behaviours matter behind a proxy:

- Uploads go through the server (up to 1 GiB per object). nginx's default 1m
  body limit breaks them — set `proxy-body-size` to `0` or a large value.
- The server only emits HSTS when the request is HTTPS or carries
  `X-Forwarded-Proto: https`. Terminate TLS at the ingress and make sure it
  forwards that header (ingress-nginx does by default).

## Gateway API

If your cluster uses Gateway API instead of (or alongside) Ingress, the chart
renders an `HTTPRoute` attaching to your existing Gateway:

```yaml
gateway:
  enabled: true
  parentRefs:
    - name: corp-gateway
      namespace: gateway-system   # optional; cross-namespace needs the grant below
      sectionName: https          # optional listener selection
  hostnames:
    - galiot.example.com
  referenceGrant:                 # only for cross-namespace attachment
    create: true
    namespace: gateway-system
```

- Requires the Gateway API CRDs (standard channel) in the cluster. Kinds:
  `HTTPRoute` (`gateway.networking.k8s.io/v1`, GA) and optionally
  `ReferenceGrant` (`v1beta1`). Galiot is HTTP-only, so no TCP/TLS routes.
- TLS terminates on the Gateway listener, not in this chart.
- The ReferenceGrant is created in the **Gateway's namespace** (not the
  release namespace): it permits HTTPRoutes from the release namespace to
  attach to Gateways there. The installer needs permission in that namespace.
- `gateway.extraRules` passes extra rules (filters, timeouts) through as-is.
  Uploads stream through the server — give the route/Gateway generous request
  timeouts if your implementation's defaults are short.

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
- Optional PodDisruptionBudget (`pdb.create`).

### NetworkPolicy

With `networkPolicy.enabled: true`, the chart allows ingress on the HTTP port.
Set `ingressFrom` to select allowed sources. The default policy manages ingress
only. When upgrading from 0.2.0, any other policy that isolates these pods for
egress will now determine which outbound connections succeed.

To manage egress here, supply a list of Kubernetes egress rules. This example
allows DNS to labeled pods and HTTPS to a single S3 address. Substitute your
cluster's resolver and endpoint.

```yaml
networkPolicy:
  enabled: true
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - {protocol: UDP, port: 53}
        - {protocol: TCP, port: 53}
    - to:
        - ipBlock: {cidr: 10.0.0.5/32}
      ports:
        - {protocol: TCP, port: 443}
```

`egress: []` isolates the pods for egress and grants no outbound connections
through this policy. Other matching policies can still allow traffic.
`egress: [{}]` explicitly allows all destinations and ports.
[Kubernetes NetworkPolicies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)

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
| `replicaCount` | `1` | One serving replica, or zero for maintenance |
| `image.repository` / `image.tag` / `image.digest` | `ghcr.io/fiztoz/galiot` / appVersion / `""` | Image; digest wins over tag |
| `gate.value` | `""` | Chart-managed gate Secret |
| `gate.existingSecret` / `gate.existingSecretKey` | `""` / `gate` | Bring-your-own gate Secret |
| `gate.open` | `false` | DANGER: unauthenticated bind |
| `branding.name` / `branding.tagline` | `""` | White-label name and title tagline |
| `branding.logo.svg` / `branding.logo.existingConfigMap` / `branding.logo.key` | `""` / `""` / `logo.svg` | Custom logo: inline SVG or mounted ConfigMap |
| `preset.endpoint` / `preset.region` / `preset.pathStyle` | `""` / `""` / `false` | Pre-fill new connection forms |
| `service.port` | `8788` | Service + container listen port (≥1024) |
| `ingress.enabled` | `false` | Ingress with hosts/TLS |
| `gateway.enabled` | `false` | Gateway API HTTPRoute (+ optional ReferenceGrant) |
| `networkPolicy.enabled` | `false` | Enable the ingress policy |
| `networkPolicy.egress` | `null` | Optional list of outbound rules |
| `pdb.create` | `false` | PDB; with 1 replica prefer `maxUnavailable: 1` |
| `resources` | 100m/128Mi req, 512Mi limit | No CPU limit by design |
| `extraEnv` / `extraVolumes` / `extraVolumeMounts` | `[]` | Escape hatches |
