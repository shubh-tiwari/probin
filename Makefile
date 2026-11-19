COMPOSE := docker compose --env-file .env -f infra/compose.yaml

.PHONY: help dev down reset logs ps migrate verify lint typecheck test check

help: ## List the commands
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  make %-10s %s\n", $$1, $$2}'

dev: .env node_modules .dev-secrets/github-app.pem ## Start the whole local stack and apply migrations
	$(COMPOSE) up --detach --build --wait
	pnpm db:migrate
	pnpm db:seed
	@echo "Stack is up. Run \"make verify\" to check it end to end."

down: ## Stop the stack, keeping its data
	$(COMPOSE) down

reset: ## Stop the stack and delete its data (Postgres and metrics)
	$(COMPOSE) down --volumes

logs: ## Follow the logs of every service
	$(COMPOSE) logs --follow --tail=50

ps: ## Show the state of every service
	$(COMPOSE) ps

migrate: .env node_modules ## Apply database migrations
	pnpm db:migrate

verify: .env node_modules ## Check the running stack end to end (phase acceptance checks and the test set)
	pnpm verify:phase0
	pnpm verify:phase1
	pnpm verify:phase2
	pnpm verify:phase3
	pnpm verify:phase4
	pnpm verify:phase5
	pnpm test:integration
	pnpm evals:query

lint: node_modules ## Lint, check formatting and check the product name is not hard-coded
	pnpm lint
	pnpm format:check
	pnpm check:product-name

typecheck: node_modules ## Type-check every package
	pnpm typecheck

test: node_modules ## Run unit tests (no containers needed)
	pnpm test

check: lint typecheck test ## Everything continuous integration runs without containers

.env:
	cp .env.example .env

# A GitHub App key for the fake GitHub. Development only; never committed or put in an image.
.dev-secrets/github-app.pem:
	mkdir -p .dev-secrets
	openssl genrsa -out $@ 2048 2>/dev/null
	chmod 644 $@

node_modules: package.json pnpm-lock.yaml pnpm-workspace.yaml
	pnpm install
	@touch node_modules
