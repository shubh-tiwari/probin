# One image for every service in apps/. Each compose service runs it with its
# own command. Built from the repository root.
#
# It runs the TypeScript source directly. Compose gives each service its own
# command; elsewhere (Railway) the default command starts the service named by
# $APP, see start.sh.
FROM node:24-alpine
# A sans-serif font for the chart images rendered on the server.
RUN apk add --no-cache font-dejavu
RUN npm install --global pnpm@12.9.1
WORKDIR /repo

# Fetch dependencies from the lockfile alone, so this layer is rebuilt only
# when dependencies change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile

USER node
CMD ["sh", "infra/docker/start.sh"]
