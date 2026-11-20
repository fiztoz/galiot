{{/* Expand the name of the chart. */}}
{{- define "galiot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fullname: release + chart, truncated to 63 chars (DNS label limit). */}}
{{- define "galiot.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Chart name and version as used by the chart label. */}}
{{- define "galiot.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Common labels. NOTE: never add these to spec.selector.matchLabels of an
existing Deployment — selectors are immutable. Selector labels below are a
separate, minimal set. */}}
{{- define "galiot.labels" -}}
helm.sh/chart: {{ include "galiot.chart" . }}
{{ include "galiot.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Selector labels — the immutable identity of the workload. */}}
{{- define "galiot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "galiot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Service account name. */}}
{{- define "galiot.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "galiot.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Image reference: digest pin wins over tag; tag defaults to appVersion. */}}
{{- define "galiot.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) }}
{{- end }}
{{- end }}

{{/* Name of the Secret holding the gate token (chart-managed or existing). */}}
{{- define "galiot.gateSecretName" -}}
{{- if .Values.gate.existingSecret }}
{{- .Values.gate.existingSecret }}
{{- else }}
{{- printf "%s-gate" (include "galiot.fullname" .) }}
{{- end }}
{{- end }}

{{/* Key inside the gate Secret. */}}
{{- define "galiot.gateSecretKey" -}}
{{- if .Values.gate.existingSecret -}}
{{- .Values.gate.existingSecretKey | default "gate" -}}
{{- else -}}
gate
{{- end -}}
{{- end }}

{{/* Fail the render on ambiguous or impossible configuration, mirroring the
server's own refusal to start. Called from deployment.yaml and the test pod. */}}
{{- define "galiot.validateConfig" -}}
{{- $g := .Values.gate -}}
{{- $value := $g.value | toString | trim -}}
{{- if and $g.open (or $value $g.existingSecret) -}}
{{- fail "gate.open=true cannot be combined with gate.value or gate.existingSecret — pick exactly one gate mode." -}}
{{- end -}}
{{- if and $value $g.existingSecret -}}
{{- fail "Set only one of gate.value or gate.existingSecret." -}}
{{- end -}}
{{- if and (not $g.open) (not $value) (not $g.existingSecret) -}}
{{- fail "A gate is required: the server refuses a non-loopback bind without one. Set gate.value, gate.existingSecret, or gate.open=true (dangerous, unauthenticated)." -}}
{{- end -}}
{{- if and $g.existingSecret (not ($g.existingSecretKey | toString | trim)) -}}
{{- fail "gate.existingSecretKey must not be empty when gate.existingSecret is set." -}}
{{- end -}}
{{- $port := int .Values.service.port -}}
{{- if or (lt $port 1024) (gt $port 65535) -}}
{{- fail (printf "service.port must be 1024-65535: the container runs as non-root uid 1000 and cannot bind privileged ports (got %v)." .Values.service.port) -}}
{{- end -}}
{{- $b := .Values.branding -}}
{{- if and $b.logo.svg $b.logo.existingConfigMap -}}
{{- fail "Set only one of branding.logo.svg or branding.logo.existingConfigMap." -}}
{{- end -}}
{{- if and $b.logo.existingConfigMap (not ($b.logo.key | toString | trim)) -}}
{{- fail "branding.logo.key must not be empty when branding.logo.existingConfigMap is set." -}}
{{- end -}}
{{- if gt (len ($b.name | toString)) 64 -}}
{{- fail "branding.name is too long (max 64 characters)." -}}
{{- end -}}
{{- $p := .Values.preset -}}
{{- if gt (len ($p.endpoint | toString)) 2048 -}}
{{- fail "preset.endpoint is too long (max 2048 characters)." -}}
{{- end -}}
{{- if and (not (kindIs "invalid" $p.pathStyle)) (ne (kindOf $p.pathStyle) "bool") -}}
{{- fail "preset.pathStyle must be a boolean: use --set preset.pathStyle=true, not a quoted string." -}}
{{- end -}}
{{- $gw := .Values.gateway -}}
{{- if $gw.enabled -}}
{{- if ne (kindOf $gw.parentRefs) "slice" -}}
{{- fail "gateway.parentRefs must be a list (supply it via a values file, not --set)." -}}
{{- end -}}
{{- if not $gw.parentRefs -}}
{{- fail "gateway.enabled requires at least one gateway.parentRefs entry — the Gateway to attach to." -}}
{{- end -}}
{{- range $gw.parentRefs -}}
{{- if not .name -}}
{{- fail "every gateway.parentRefs entry needs a name." -}}
{{- end -}}
{{- end -}}
{{- if and $gw.referenceGrant.create (not ($gw.referenceGrant.namespace | toString | trim)) -}}
{{- fail "gateway.referenceGrant.namespace is required when create is true — it must be the Gateway's namespace." -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Gate environment for the server container AND the helm-test pod — one
source of truth so the two can never disagree. Emits a YAML list fragment. */}}
{{- define "galiot.gateEnv" -}}
{{- if .Values.gate.open -}}
- name: GALIOT_GATE_OPEN
  value: "1"
{{- else -}}
- name: GALIOT_GATE
  valueFrom:
    secretKeyRef:
      name: {{ include "galiot.gateSecretName" . }}
      key: {{ include "galiot.gateSecretKey" . }}
{{- end }}
{{- end }}

{{/* Branding: mount path, ConfigMap name/key, and env fragment. */}}
{{- define "galiot.brandingMountPath" -}}
/etc/galiot/branding
{{- end }}

{{- define "galiot.brandingConfigMapName" -}}
{{- if .Values.branding.logo.existingConfigMap -}}
{{- .Values.branding.logo.existingConfigMap -}}
{{- else -}}
{{- printf "%s-branding" (include "galiot.fullname" .) -}}
{{- end -}}
{{- end }}

{{- define "galiot.brandingLogoKey" -}}
{{- if .Values.branding.logo.existingConfigMap -}}
{{- .Values.branding.logo.key | default "logo.svg" -}}
{{- else -}}
logo.svg
{{- end -}}
{{- end }}

{{- define "galiot.brandingEnv" -}}
{{- if .Values.branding.name }}
- name: GALIOT_BRAND_NAME
  value: {{ .Values.branding.name | quote }}
{{- end }}
{{- if .Values.branding.tagline }}
- name: GALIOT_BRAND_TAGLINE
  value: {{ .Values.branding.tagline | quote }}
{{- end }}
{{- if or .Values.branding.logo.svg .Values.branding.logo.existingConfigMap }}
- name: GALIOT_BRAND_LOGO
  value: "{{ include "galiot.brandingMountPath" . }}/{{ include "galiot.brandingLogoKey" . }}"
{{- end }}
{{- end }}

{{/* Preset connection defaults. Same fragment rules as brandingEnv: each
branch supplies its own leading newline. */}}
{{- define "galiot.presetEnv" -}}
{{- if .Values.preset.endpoint }}
- name: GALIOT_PRESET_ENDPOINT
  value: {{ .Values.preset.endpoint | quote }}
{{- end }}
{{- if .Values.preset.region }}
- name: GALIOT_PRESET_REGION
  value: {{ .Values.preset.region | quote }}
{{- end }}
{{- if .Values.preset.pathStyle }}
- name: GALIOT_PRESET_PATH_STYLE
  value: "1"
{{- end }}
{{- end }}
