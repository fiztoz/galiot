#!/usr/bin/env bash
# Galiot Helm chart gate.
#
#   bash scripts/helm-check.sh          # lint + render matrix + negative renders
#   bash scripts/helm-check.sh --live   # additionally install into a scratch
#                                       # namespace on the CURRENT kubectl
#                                       # context, prove health + gate over
#                                       # HTTP, run helm test, tear down.
#
# Offline mode needs only helm. If kubeconform is on PATH (or $KUBECONFORM),
# rendered manifests are also schema-validated. The scratch gate value is
# random and never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$ROOT/deploy/helm/galiot"
LIVE=0
[[ "${1:-}" == "--live" ]] && LIVE=1

command -v helm >/dev/null 2>&1 || { echo "FAIL: helm is not on PATH"; exit 1; }

WORK="$(mktemp -d)"
GATE="$(openssl rand -hex 24)"
HDR='x-galiot-access-token'
PF_PID=""
LIVE_NS=""

cleanup() {
  [[ -n "$PF_PID" ]] && kill "$PF_PID" 2>/dev/null || true
  if [[ -n "$LIVE_NS" ]]; then
    helm uninstall galiot -n "$LIVE_NS" --wait 2>/dev/null || true
    kubectl delete namespace "$LIVE_NS" --wait=false 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

tpl() { helm template galiot "$CHART" "$@"; }

pass=0
ok() { pass=$((pass + 1)); echo "  ok: $1"; }

assert_contains() { # file, pattern, label
  grep -q -- "$2" "$1" || { echo "FAIL: $3 (missing: $2)"; exit 1; }
  ok "$3"
}
assert_absent() { # file, pattern, label
  if grep -q -- "$2" "$1"; then echo "FAIL: $3 (unexpected: $2)"; exit 1; fi
  ok "$3"
}
assert_render_fails() { # label, args...
  local label="$1"; shift
  if tpl "$@" >"$WORK/negative.yaml" 2>"$WORK/negative.err"; then
    echo "FAIL: render should have failed: $label"; exit 1
  fi
  ok "negative render rejected: $label"
}

echo "== helm lint =="
helm lint "$CHART" --set gate.value="$GATE" --quiet
ok "lint"

echo "== case 1: defaults (chart-managed gate) =="
tpl --set gate.open=false --set gate.value="$GATE" > "$WORK/default.yaml"
assert_contains "$WORK/default.yaml" '^kind: Deployment' "Deployment renders"
assert_contains "$WORK/default.yaml" '^kind: Service$' "Service renders"
assert_contains "$WORK/default.yaml" '^kind: Secret' "gate Secret renders"
assert_contains "$WORK/default.yaml" '^kind: ServiceAccount' "ServiceAccount renders"
assert_absent  "$WORK/default.yaml" '^kind: Ingress' "no Ingress by default"
assert_absent  "$WORK/default.yaml" '^kind: NetworkPolicy' "no NetworkPolicy by default"
assert_absent  "$WORK/default.yaml" '^kind: PodDisruptionBudget' "no PDB by default"
assert_contains "$WORK/default.yaml" 'name: galiot-gate' "secretKeyRef names the rendered Secret"
assert_contains "$WORK/default.yaml" 'key: gate' "secretKeyRef key matches the Secret"
assert_absent  "$WORK/default.yaml" 'name: GALIOT_GATE_OPEN' "boolean false keeps the token gate"
assert_contains "$WORK/default.yaml" 'checksum/gate:' "chart-managed gate rotation rolls pods"
tpl --set gate.open=false --set gate.value="$GATE-rotated" > "$WORK/rotated.yaml"
if [ "$(grep -o 'checksum/gate: .*' "$WORK/default.yaml")" = "$(grep -o 'checksum/gate: .*' "$WORK/rotated.yaml")" ]; then
  echo "FAIL: rotating gate.value does not change the pod checksum"; exit 1
fi
echo "ok: rotating gate.value changes the pod checksum"
assert_contains "$WORK/default.yaml" 'value: "http://galiot:8788"' "test pod targets the rendered Service"
assert_contains "$WORK/default.yaml" 'path: /api/health' "probes use /api/health"
assert_contains "$WORK/default.yaml" 'runAsNonRoot: true' "pod runs non-root"
assert_contains "$WORK/default.yaml" 'readOnlyRootFilesystem: true' "root filesystem read-only"
assert_contains "$WORK/default.yaml" 'automountServiceAccountToken: false' "no API token automount"
assert_contains "$WORK/default.yaml" 'replicas: 1' "single replica by default"
assert_contains "$WORK/default.yaml" '^    type: Recreate$' "upgrade stops the previous issuer first"
assert_absent  "$WORK/default.yaml" 'rollingUpdate:' "no surge settings on a Recreate Deployment"
assert_absent  "$WORK/default.yaml" 'name: GALIOT_BRAND_NAME' "no branding env by default"
assert_absent  "$WORK/default.yaml" 'name: GALIOT_PRESET_ENDPOINT' "no preset env by default"

echo "== case 2: existingSecret =="
tpl --set gate.existingSecret=my-gate --set gate.existingSecretKey=token > "$WORK/existing.yaml"
assert_absent  "$WORK/existing.yaml" '^kind: Secret' "no chart Secret when existingSecret is set"
assert_contains "$WORK/existing.yaml" 'name: my-gate' "secretKeyRef uses the existing Secret"
assert_contains "$WORK/existing.yaml" 'key: token' "secretKeyRef uses the custom key"

echo "== case 3: ingress + TLS =="
cat > "$WORK/ingress-values.yaml" <<EOF
gate:
  value: "$GATE"
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "0"
  hosts:
    - host: galiot.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: galiot-tls
      hosts:
        - galiot.example.com
EOF
tpl -f "$WORK/ingress-values.yaml" > "$WORK/ingress.yaml"
assert_contains "$WORK/ingress.yaml" '^kind: Ingress' "Ingress renders when enabled"
assert_contains "$WORK/ingress.yaml" 'host: "galiot.example.com"' "ingress host renders"
assert_contains "$WORK/ingress.yaml" 'secretName: galiot-tls' "ingress TLS renders"
assert_contains "$WORK/ingress.yaml" 'ingressClassName: nginx' "ingress class renders"
assert_contains "$WORK/ingress.yaml" 'proxy-body-size' "ingress annotations render"
assert_absent "$WORK/ingress.yaml" 'name: GALIOT_PUBLIC_ORIGINS' "token gate skips ingress origin generation"

echo "== case 4: networkPolicy =="
tpl --set gate.value="$GATE" --set networkPolicy.enabled=true > "$WORK/netpol.yaml"
assert_contains "$WORK/netpol.yaml" '^kind: NetworkPolicy' "NetworkPolicy renders when enabled"
assert_contains "$WORK/netpol.yaml" '- Ingress' "policy types include Ingress"
assert_absent  "$WORK/netpol.yaml" '- Egress' "default policy manages ingress only"
assert_absent  "$WORK/netpol.yaml" '^  egress:' "default policy grants no egress rules"
assert_absent  "$WORK/netpol.yaml" '^      from:' "default ingress accepts all sources on the HTTP port"
tpl --show-only templates/networkpolicy.yaml --set gate.existingSecret=my-gate \
  --set networkPolicy.enabled=true --set-json 'networkPolicy.ingressFrom=[{}]' > "$WORK/netpol-legacy.yaml"
assert_absent "$WORK/netpol-legacy.yaml" '^      from:' "legacy default renders valid unrestricted sources"
tpl --show-only templates/networkpolicy.yaml --set gate.existingSecret=my-gate \
  --set networkPolicy.enabled=true --set-json 'networkPolicy.egress=[]' > "$WORK/netpol-empty.yaml"
assert_contains "$WORK/netpol-empty.yaml" '- Egress' "explicit empty rules isolate egress"
assert_contains "$WORK/netpol-empty.yaml" '^    \[\]$' "empty rules grant no outbound connections"
tpl --show-only templates/networkpolicy.yaml --set gate.existingSecret=my-gate \
  --set networkPolicy.enabled=true \
  --set-json 'networkPolicy.ingressFrom=[{"podSelector":{"matchLabels":{"role":"gateway"}}}]' \
  --set-json 'networkPolicy.egress=[{"to":[{"ipBlock":{"cidr":"10.0.0.5/32"}}],"ports":[{"protocol":"TCP","port":443}]}]' > "$WORK/netpol-scoped.yaml"
assert_contains "$WORK/netpol-scoped.yaml" 'role: gateway' "custom ingress peer preserved"
assert_contains "$WORK/netpol-scoped.yaml" '- Egress' "explicit rules manage egress"
assert_contains "$WORK/netpol-scoped.yaml" 'cidr: 10.0.0.5/32' "outbound destination preserved"
assert_contains "$WORK/netpol-scoped.yaml" 'port: 443' "outbound port preserved"
assert_absent "$WORK/netpol-scoped.yaml" '- {}' "no unrestricted rule added to scoped policy"

echo "== case 5: PDB =="
tpl --set gate.value="$GATE" --set pdb.create=true > "$WORK/pdb.yaml"
assert_contains "$WORK/pdb.yaml" '^kind: PodDisruptionBudget' "PDB renders when enabled"
assert_contains "$WORK/pdb.yaml" 'minAvailable: 1' "PDB defaults to minAvailable"
tpl --set gate.value="$GATE" --set pdb.create=true --set pdb.maxUnavailable=1 > "$WORK/pdb2.yaml"
assert_contains "$WORK/pdb2.yaml" 'maxUnavailable: 1' "PDB maxUnavailable override"
assert_absent  "$WORK/pdb2.yaml" 'minAvailable' "maxUnavailable replaces minAvailable"

echo "== case 6: open bind (dangerous) =="
tpl --set gate.open=true > "$WORK/open.yaml"
assert_absent  "$WORK/open.yaml" '^kind: Secret' "no Secret in open mode"
assert_contains "$WORK/open.yaml" 'name: GALIOT_GATE_OPEN' "open mode sets GALIOT_GATE_OPEN"
assert_absent  "$WORK/open.yaml" 'name: GALIOT_GATE$' "no gate env in open mode"
assert_absent  "$WORK/open.yaml" 'name: GALIOT_PUBLIC_ORIGINS' "disabled ingress contributes no origins"

echo "== case 6b: open ingress browser origins =="
cat > "$WORK/origins-values.yaml" <<'EOF'
gate:
  open: true
ingress:
  enabled: true
  hosts:
    - host: secure.example.com
      paths: &paths [{path: /, pathType: Prefix}]
    - {host: files.dev.example.com, paths: *paths}
    - {host: deep.files.dev.example.com, paths: *paths}
    - {host: "*.example.com", paths: *paths}
    - {paths: *paths}
    - host: secure.example.com
      paths: [{path: /files, pathType: Prefix}]
  tls:
    - hosts: [secure.example.com, tls-only.example.com]
    - hosts: ["*.dev.example.com"]
EOF
origins_deploy() {
  tpl -f "$WORK/origins-values.yaml" --show-only templates/deployment.yaml "$@"
}
origins_deploy --set-json 'extraEnv=[{"name":"TZ","value":"UTC"}]' > "$WORK/origins.yaml"
assert_contains "$WORK/origins.yaml" 'name: GALIOT_PUBLIC_ORIGINS$' "open ingress sets server origins"
assert_contains "$WORK/origins.yaml" 'value: "https://secure\.example\.com,https://files\.dev\.example\.com,http://deep\.files\.dev\.example\.com"$' "only concrete route hosts appear once with their public schemes"
origins_deploy --set-json 'ingress.hosts=[{"host":"*.example.com","paths":[{"path":"/","pathType":"Prefix"}]},{"host":"","paths":[{"path":"/","pathType":"Prefix"}]}]' > "$WORK/origins-wildcard.yaml"
assert_absent "$WORK/origins-wildcard.yaml" 'name: GALIOT_PUBLIC_ORIGINS' "wildcard and hostless routes grant no origins"

origins_deploy --set-json 'extraEnv=[{"name":"GALIOT_PUBLIC_ORIGINS","value":"https://proxy.example.com:8443"}]' > "$WORK/origins-override.yaml"
assert_contains "$WORK/origins-override.yaml" 'https://proxy\.example\.com:8443' "explicit origin preserves public scheme and port"
origins_deploy --set-json 'extraEnv=[{"name":"GALIOT_PUBLIC_ORIGINS","valueFrom":{"configMapKeyRef":{"name":"public-origins","key":"origins"}}}]' > "$WORK/origins-from.yaml"
assert_contains "$WORK/origins-from.yaml" 'name: public-origins' "explicit origins can come from a ConfigMap"
for f in origins-override origins-from; do
  [[ "$(grep -c 'name: GALIOT_PUBLIC_ORIGINS$' "$WORK/$f.yaml")" == 1 ]] || { echo "FAIL: expected one origins entry in $f"; exit 1; }
  ok "only the operator's origins entry renders in $f"
done

echo "== case 7: replicas edge values =="
assert_render_fails "multiple grant issuers" --set gate.value="$GATE" --set replicaCount=2
tpl --set gate.value="$GATE" --set replicaCount=0 > "$WORK/r0.yaml"
assert_contains "$WORK/r0.yaml" 'replicas: 0' "can scale down for maintenance"

echo "== case 8: custom port + digest pin =="
tpl --set gate.value="$GATE" --set service.port=9000 > "$WORK/port.yaml"
assert_contains "$WORK/port.yaml" 'value: "9000"' "GALIOT_PORT follows service.port"
assert_contains "$WORK/port.yaml" 'containerPort: 9000' "containerPort follows service.port"
tpl --set gate.value="$GATE" --set image.digest=sha256:abc123 > "$WORK/digest.yaml"
assert_contains "$WORK/digest.yaml" 'image: ghcr.io/fiztoz/galiot@sha256:abc123' "digest pin wins over tag"

echo "== case 9: branding (name + inline SVG logo) =="
cat > "$WORK/branding-values.yaml" <<EOF
gate:
  value: "$GATE"
branding:
  name: Acme Explorer
  tagline: Company object storage
  logo:
    svg: '<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>'
EOF
tpl -f "$WORK/branding-values.yaml" > "$WORK/branded.yaml"
assert_contains "$WORK/branded.yaml" '^kind: ConfigMap' "branding ConfigMap renders"
assert_contains "$WORK/branded.yaml" 'name: GALIOT_BRAND_NAME' "brand name env renders"
assert_contains "$WORK/branded.yaml" 'value: "Acme Explorer"' "brand name value renders"
assert_contains "$WORK/branded.yaml" 'name: GALIOT_BRAND_TAGLINE' "tagline env renders"
assert_contains "$WORK/branded.yaml" 'value: "/etc/galiot/branding/logo.svg"' "logo env points at the mount"
assert_contains "$WORK/branded.yaml" 'mountPath: /etc/galiot/branding' "logo volume is mounted"
assert_contains "$WORK/branded.yaml" 'name: galiot-branding' "volume names the rendered ConfigMap"
assert_contains "$WORK/branded.yaml" 'checksum/branding' "logo change rolls the pods"

echo "== case 10: branding (existing ConfigMap, png key) =="
tpl --set gate.value="$GATE" --set branding.logo.existingConfigMap=acme-logo --set branding.logo.key=logo.png > "$WORK/branded-existing.yaml"
assert_absent  "$WORK/branded-existing.yaml" '^kind: ConfigMap' "no chart ConfigMap for existingConfigMap"
assert_contains "$WORK/branded-existing.yaml" 'value: "/etc/galiot/branding/logo.png"' "logo env follows the custom key"
assert_contains "$WORK/branded-existing.yaml" 'name: acme-logo' "volume names the existing ConfigMap"
assert_contains "$WORK/branded-existing.yaml" 'key: logo.png' "volume items select the custom key"

echo "== case 11: preset connection defaults =="
tpl --set gate.value="$GATE" --set preset.endpoint=https://s3.example.com --set preset.region=eu-central-1 --set preset.pathStyle=true > "$WORK/preset.yaml"
assert_contains "$WORK/preset.yaml" 'name: GALIOT_PRESET_ENDPOINT' "preset endpoint env renders"
assert_contains "$WORK/preset.yaml" 'value: "https://s3.example.com"' "preset endpoint value renders"
assert_contains "$WORK/preset.yaml" 'name: GALIOT_PRESET_REGION' "preset region env renders"
assert_contains "$WORK/preset.yaml" 'value: "eu-central-1"' "preset region value renders"
assert_contains "$WORK/preset.yaml" 'name: GALIOT_PRESET_PATH_STYLE' "preset path-style env renders"
assert_contains "$WORK/preset.yaml" 'value: "1"' "path-style uses the 1 convention"

echo "== case 12: Gateway API (cross-namespace + ReferenceGrant) =="
cat > "$WORK/gateway-values.yaml" <<EOF
gate:
  value: "$GATE"
gateway:
  enabled: true
  parentRefs:
    - name: corp-gateway
      namespace: gateway-system
      sectionName: https
  hostnames:
    - galiot.example.com
  referenceGrant:
    create: true
    namespace: gateway-system
EOF
tpl -f "$WORK/gateway-values.yaml" > "$WORK/gateway.yaml"
assert_contains "$WORK/gateway.yaml" '^kind: HTTPRoute' "HTTPRoute renders when enabled"
assert_contains "$WORK/gateway.yaml" 'apiVersion: gateway.networking.k8s.io/v1$' "HTTPRoute uses the GA v1 API"
assert_contains "$WORK/gateway.yaml" 'name: corp-gateway' "parentRef names the Gateway"
assert_contains "$WORK/gateway.yaml" 'namespace: gateway-system' "cross-namespace parentRef renders"
assert_contains "$WORK/gateway.yaml" 'sectionName: https' "listener sectionName renders"
assert_contains "$WORK/gateway.yaml" '- galiot.example.com' "hostname renders"
assert_contains "$WORK/gateway.yaml" '^kind: ReferenceGrant' "ReferenceGrant renders for cross-namespace"
assert_contains "$WORK/gateway.yaml" 'apiVersion: gateway.networking.k8s.io/v1beta1' "ReferenceGrant uses v1beta1"

echo "== case 12b: Gateway API (same namespace, empty hostnames) =="
cat > "$WORK/gateway-local-values.yaml" <<EOF
gate:
  value: "$GATE"
gateway:
  enabled: true
  parentRefs:
    - name: corp-gateway
  hostnames: []
EOF
tpl -f "$WORK/gateway-local-values.yaml" > "$WORK/gateway-local.yaml"
assert_absent  "$WORK/gateway-local.yaml" '^kind: ReferenceGrant' "no grant for same-namespace attachment"
assert_absent  "$WORK/gateway-local.yaml" 'hostnames:' "empty hostnames list is omitted"
assert_contains "$WORK/gateway-local.yaml" 'name: corp-gateway' "parentRef still renders"

echo "== negative renders (must fail) =="
assert_render_fails "no gate configured"
assert_render_fails "boolean false needs a token" --set gate.open=false
assert_render_fails "string false" --set-string gate.open=false
assert_render_fails "string true" --set-string gate.open=true
assert_render_fails "numeric gate mode" --set gate.open=1
assert_render_fails "numeric zero with a token" --set gate.open=0 --set gate.existingSecret=my-gate
assert_render_fails "null gate mode with a token" --set gate.open=null --set gate.existingSecret=my-gate
assert_render_fails "egress rules must be a list" --set gate.existingSecret=my-gate --set networkPolicy.enabled=true --set-string networkPolicy.egress=false
assert_render_fails "null egress rule" --set gate.existingSecret=my-gate --set networkPolicy.enabled=true --set-json 'networkPolicy.egress=[null]'
assert_render_fails "gate.value + gate.existingSecret" --set gate.value="$GATE" --set gate.existingSecret=my-gate
assert_render_fails "gate.open + gate.value" --set gate.open=true --set gate.value="$GATE"
assert_render_fails "privileged port 80" --set gate.value="$GATE" --set service.port=80
assert_render_fails "empty existingSecretKey" --set gate.existingSecret=my-gate --set gate.existingSecretKey=""
cat > "$WORK/branding-both-values.yaml" <<EOF
gate:
  value: "$GATE"
branding:
  logo:
    svg: '<svg viewBox="0 0 8 8"/>'
    existingConfigMap: acme-logo
EOF
assert_render_fails "branding.logo.svg + existingConfigMap" -f "$WORK/branding-both-values.yaml"
assert_render_fails "overlong branding.name" --set gate.value="$GATE" --set branding.name="$(printf 'x%.0s' $(seq 1 65))"
assert_render_fails "string preset.pathStyle" --set gate.value="$GATE" --set-string preset.pathStyle=false
cat > "$WORK/gateway-noparents-values.yaml" <<EOF
gate:
  value: "$GATE"
gateway:
  enabled: true
  parentRefs: []
EOF
assert_render_fails "gateway.enabled without parentRefs" -f "$WORK/gateway-noparents-values.yaml"
cat > "$WORK/gateway-nograntns-values.yaml" <<EOF
gate:
  value: "$GATE"
gateway:
  enabled: true
  parentRefs:
    - name: corp-gateway
  referenceGrant:
    create: true
EOF
assert_render_fails "referenceGrant.create without namespace" -f "$WORK/gateway-nograntns-values.yaml"

KUBECONFORM="${KUBECONFORM:-$(command -v kubeconform || true)}"
if [[ -n "$KUBECONFORM" ]]; then
  echo "== kubeconform schema validation =="
  for f in default existing ingress netpol netpol-legacy netpol-empty netpol-scoped pdb pdb2 open origins origins-wildcard origins-override origins-from r0 port digest branded branded-existing preset; do
    "$KUBECONFORM" -strict -summary -kubernetes-version 1.31.0 "$WORK/$f.yaml"
  done
  # Gateway API kinds are CRDs: validate against the community CRD schema catalog.
  for f in gateway gateway-local; do
    "$KUBECONFORM" -strict -summary -kubernetes-version 1.31.0 \
      -schema-location default \
      -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/784ec895547a36e548e6810b41f27baade3a0890/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
      "$WORK/$f.yaml"
  done
  ok "schema validation"
else
  echo "note: kubeconform not found — skipping schema validation (CI runs it)"
fi

if [[ "$LIVE" == 1 ]]; then
  echo "== LIVE verification (scratch namespace, torn down on exit) =="
  command -v kubectl >/dev/null 2>&1 || { echo "FAIL: kubectl is not on PATH"; exit 1; }
  kubectl cluster-info >/dev/null 2>&1 || { echo "FAIL: no reachable cluster in the current kubectl context"; exit 1; }
  LIVE_NS="galiot-helm-verify-$$"
  helm install galiot "$CHART" -n "$LIVE_NS" --create-namespace \
    --set gate.value="$GATE" --wait --timeout 240s
  kubectl -n "$LIVE_NS" rollout status deployment/galiot --timeout=120s
  ok "release installed and rolled out"

  kubectl -n "$LIVE_NS" port-forward svc/galiot 18788:8788 >/dev/null 2>&1 &
  PF_PID=$!
  up=0
  for _ in $(seq 1 30); do
    if curl -sf http://127.0.0.1:18788/api/health >/dev/null 2>&1; then up=1; break; fi
    sleep 0.5
  done
  [[ "$up" == 1 ]] || { echo "FAIL: port-forward never became healthy"; exit 1; }

  body="$(curl -sf http://127.0.0.1:18788/api/health)"
  [[ "$body" == *'"tokenRequired":true'* ]] || { echo "FAIL: gate not required: $body"; exit 1; }
  [[ "$body" == *'"tokenAccepted":false'* ]] || { echo "FAIL: anonymous accepted"; exit 1; }
  ok "health reports gate required, anonymous rejected"

  body="$(curl -sf -H "$HDR: probe-$RANDOM$RANDOM" http://127.0.0.1:18788/api/health)"
  [[ "$body" == *'"tokenAccepted":false'* ]] || { echo "FAIL: wrong probe accepted"; exit 1; }
  ok "wrong probe rejected"

  body="$(curl -sf -H "$HDR: $GATE" http://127.0.0.1:18788/api/health)"
  [[ "$body" == *'"tokenAccepted":true'* ]] || { echo "FAIL: configured gate rejected — Secret wiring wrong"; exit 1; }
  ok "configured gate accepted (Secret wiring proven)"

  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18788/api/s3)"
  [[ "$code" == 403 ]] || { echo "FAIL: /api/s3 without gate returned $code, expected 403"; exit 1; }
  ok "/api/s3 without gate returns 403"

  kill "$PF_PID" 2>/dev/null || true
  PF_PID=""
  helm test galiot -n "$LIVE_NS" --timeout 120s
  ok "helm test passed"
  echo "LIVE verification passed; tearing down $LIVE_NS"
fi

echo "PASS: $pass assertions"
