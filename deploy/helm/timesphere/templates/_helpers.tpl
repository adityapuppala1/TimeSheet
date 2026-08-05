{{/*
Chart name, truncated and DNS-1123-safe.
*/}}
{{- define "timesphere.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name, e.g. "my-release-timesphere".
*/}}
{{- define "timesphere.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "timesphere.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels applied to every resource in this chart.
*/}}
{{- define "timesphere.labels" -}}
app.kubernetes.io/name: {{ include "timesphere.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/*
Selector labels - the subset a Deployment/Service/HPA uses to match its own pods. Must never
change across releases of the same component, unlike the full label set above.
*/}}
{{- define "timesphere.selectorLabels" -}}
app.kubernetes.io/name: {{ include "timesphere.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Full image ref for a component, e.g. ghcr.io/org/repo-api:latest.
*/}}
{{- define "timesphere.image" -}}
{{- printf "%s/%s-%s:%s" .root.Values.image.registry .root.Values.image.repository .component .root.Values.image.tag -}}
{{- end -}}
