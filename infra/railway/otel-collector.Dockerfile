# The collector on Railway, with its config built in (Railway cannot mount files).
FROM otel/opentelemetry-collector-contrib:0.165.0
COPY infra/otel-collector/config.yaml /etc/otelcol/config.yaml
CMD ["--config=/etc/otelcol/config.yaml"]
