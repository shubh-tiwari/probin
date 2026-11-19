FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# Probin metrics. The ingestion URL (OTEL_EXPORTER_OTLP_ENDPOINT) and the key
# (OTEL_EXPORTER_OTLP_HEADERS) come from the deployment and its secret store,
# never from this file. Without them the service runs and exports nothing.
ENV OTEL_SERVICE_NAME=checkout
ENV OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
USER node
EXPOSE 8080
CMD ["node", "--require", "./instrumentation.cjs", "server.cjs"]
