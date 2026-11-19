# The agent (Python). Built from the repository root.
#
# It reads the product name from packages/config/src/product.ts and the models
# file from config/, so those are copied in; nothing else from the TypeScript side.
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.11.14 /uv /uvx /bin/
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    APP_REPO_ROOT=/app \
    PYTHONUNBUFFERED=1

# Dependencies first, from the lockfile alone, so this layer is rebuilt only
# when dependencies change.
COPY pyproject.toml uv.lock ./
COPY packages/pycommon/pyproject.toml packages/pycommon/
COPY packages/router/pyproject.toml packages/router/
COPY apps/agent/pyproject.toml apps/agent/
COPY apps/connector/pyproject.toml apps/connector/
RUN uv sync --frozen --no-dev --package app-agent --no-install-workspace

COPY packages/pycommon/src packages/pycommon/src
COPY packages/router/src packages/router/src
COPY apps/agent/src apps/agent/src
RUN uv sync --frozen --no-dev --package app-agent

COPY packages/config/src/product.ts packages/config/src/product.ts
COPY config config
COPY evals evals

RUN useradd --create-home --uid 10001 agent
USER agent
EXPOSE 8080
CMD ["/app/.venv/bin/agent"]
