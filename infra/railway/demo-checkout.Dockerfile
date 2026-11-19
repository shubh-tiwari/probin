# The checkout demo service, built from the repository root (Railway's build context).
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV OTEL_SERVICE_NAME=checkout
ENV OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
COPY infra/demo/checkout-node/package.json infra/demo/checkout-node/package-lock.json ./
RUN npm ci --omit=dev
COPY infra/demo/checkout-node/ ./
USER node
EXPOSE 8080
CMD ["node", "--require", "./instrumentation.cjs", "server.cjs"]
