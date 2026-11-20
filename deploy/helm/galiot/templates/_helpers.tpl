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
