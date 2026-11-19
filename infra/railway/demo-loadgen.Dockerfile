# Steady traffic to the demo services, built from the repository root.
FROM node:24-alpine
WORKDIR /app
COPY infra/demo/loadgen/loadgen.mjs ./
USER node
CMD ["node", "loadgen.mjs"]
