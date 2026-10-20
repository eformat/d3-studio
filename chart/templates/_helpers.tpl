{{/*
Expand the name of the chart.
*/}}
{{- define "d3-studio.name" -}}
{{- default (default .Chart.Name .Release.Name) .Values.studio.name | trunc 63 | trimSuffix "-" }}
{{- end }}


{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "d3-studio.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}


{{/*
Common labels
*/}}
{{- define "d3-studio.labels" -}}
helm.sh/chart: {{ include "d3-studio.chart" . }}
{{ include "d3-studio.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}


{{/*
Selector labels
*/}}
{{- define "d3-studio.selectorLabels" -}}
app: {{ include "d3-studio.name" . }}
app.kubernetes.io/name: {{ include "d3-studio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: {{ include "d3-studio.name" . }}
{{- end }}


{{/*
Create the name of the service account to use
*/}}
{{- define "d3-studio.serviceAccountName" -}}
{{- if .Values.studio.serviceAccount.create }}
{{- default (include "d3-studio.name" .) .Values.studio.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.studio.serviceAccount.name }}
{{- end }}
{{- end }}


{{/*
The merged environment for the app: the chart's own D3_DEVICE (cuda with the
GPU enabled, cpu without) and D3_OFFLINE (1 when the init pull delivers the
weights) under the user's env values, so a value in .Values.studio.env wins.
*/}}
{{- define "d3-studio.env" -}}
{{- $env := deepCopy (.Values.studio.env | default dict) -}}
{{- $pulled := ne (.Values.studio.weights.mode | default "pvc") "none" -}}
{{- if .Values.studio.gpu.enabled -}}
{{- $_ := set $env "D3_DEVICE" (default "cuda" (get $env "D3_DEVICE")) -}}
{{- else -}}
{{- $_ := set $env "D3_DEVICE" (default "cpu" (get $env "D3_DEVICE")) -}}
{{- end -}}
{{- if $pulled -}}
{{- $_ := set $env "D3_OFFLINE" (default "1" (get $env "D3_OFFLINE")) -}}
{{- end -}}
{{- $_ := set $env "D3_MODEL" (default .Values.studio.model.repo (get $env "D3_MODEL")) -}}
{{- $_ := set $env "D3_REVISION" (default .Values.studio.model.revision (get $env "D3_REVISION")) -}}
{{- $_ := set $env "HF_HOME" (default "/weights" (get $env "HF_HOME")) -}}
{{- range $key, $value := $env }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end }}
{{- end }}
