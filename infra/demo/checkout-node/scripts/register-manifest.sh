#!/usr/bin/env bash
# Registers probin.yaml with Probin. Uses the same endpoint and key as metric export.
set -euo pipefail
: "${OTEL_EXPORTER_OTLP_ENDPOINT:?set OTEL_EXPORTER_OTLP_ENDPOINT to the ingestion URL}"
: "${OTEL_EXPORTER_OTLP_HEADERS:?set OTEL_EXPORTER_OTLP_HEADERS to Authorization=Bearer <key>}"
manifest="$(dirname "$0")/../probin.yaml"
curl --fail-with-body --silent --show-error \
  --request POST "${OTEL_EXPORTER_OTLP_ENDPOINT%/}/v1/manifests" \
  --header "${OTEL_EXPORTER_OTLP_HEADERS/=/: }" \
  --header 'content-type: application/yaml' \
  --data-binary "@${manifest}"
echo
