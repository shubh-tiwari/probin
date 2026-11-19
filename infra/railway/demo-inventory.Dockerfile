# The inventory demo service, built from the repository root (Railway's build context).
# HOST=:: makes it reachable on Railway's private network.
FROM python:3.13-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
ENV OTEL_SERVICE_NAME=inventory
COPY infra/demo/inventory-python/requirements.txt ./
RUN pip install -r requirements.txt
COPY infra/demo/inventory-python/ ./
RUN useradd --create-home app
USER app
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn main:app --host \"${HOST:-0.0.0.0}\" --port \"${PORT:-8080}\""]
