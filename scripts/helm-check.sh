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
tpl --set gate.value="$GATE" > "$WORK/default.yaml"
assert_contains "$WORK/default.yaml" '^kind: Deployment' "Deployment renders"
assert_contains "$WORK/default.yaml" '^kind: Service$' "Service renders"
assert_contains "$WORK/default.yaml" '^kind: Secret' "gate Secret renders"
assert_contains "$WORK/default.yaml" '^kind: ServiceAccount' "ServiceAccount renders"
assert_absent  "$WORK/default.yaml" '^kind: Ingress' "no Ingress by default"
assert_absent  "$WORK/default.yaml" '^kind: NetworkPolicy' "no NetworkPolicy by default"
assert_absent  "$WORK/default.yaml" '^kind: PodDisruptionBudget' "no PDB by default"
assert_contains "$WORK/default.yaml" 'name: galiot-gate' "secretKeyRef names the rendered Secret"
assert_contains "$WORK/default.yaml" 'key: gate' "secretKeyRef key matches the Secret"
assert_contains "$WORK/default.yaml" 'value: "http://galiot:8788"' "test pod targets the rendered Service"
assert_contains "$WORK/default.yaml" 'path: /api/health' "probes use /api/health"
assert_contains "$WORK/default.yaml" 'runAsNonRoot: true' "pod runs non-root"
assert_contains "$WORK/default.yaml" 'readOnlyRootFilesystem: true' "root filesystem read-only"
assert_contains "$WORK/default.yaml" 'automountServiceAccountToken: false' "no API token automount"
assert_contains "$WORK/default.yaml" 'replicas: 1' "single replica by default"
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

echo "== case 4: networkPolicy =="
tpl --set gate.value="$GATE" --set networkPolicy.enabled=true > "$WORK/netpol.yaml"
assert_contains "$WORK/netpol.yaml" '^kind: NetworkPolicy' "NetworkPolicy renders when enabled"
assert_contains "$WORK/netpol.yaml" '- Ingress' "policy types include Ingress"
assert_contains "$WORK/netpol.yaml" '- Egress' "policy types include Egress"

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

echo "== case 7: replicas edge values =="
tpl --set gate.value="$GATE" --set replicaCount=3 > "$WORK/r3.yaml"
assert_contains "$WORK/r3.yaml" 'replicas: 3' "replicaCount=3 renders"
tpl --set gate.value="$GATE" --set replicaCount=0 > "$WORK/r0.yaml"
assert_contains "$WORK/r0.yaml" 'replicas: 0' "replicaCount=0 renders (kindIs guard)"

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

echo "== negative renders (must fail) =="
assert_render_fails "no gate configured"
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

KUBECONFORM="${KUBECONFORM:-$(command -v kubeconform || true)}"
if [[ -n "$KUBECONFORM" ]]; then
  echo "== kubeconform schema validation =="
  for f in default existing ingress netpol pdb pdb2 open r3 r0 port digest branded branded-existing preset; do
    "$KUBECONFORM" -strict -summary -kubernetes-version 1.31.0 "$WORK/$f.yaml"
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
