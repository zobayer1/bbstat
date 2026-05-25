# BBSTAT — root Makefile
#
# Convenience wrapper around docker compose + pnpm. Run from the repo root.
# `make help` lists every target. Targets are .PHONY (no real file outputs).

SHELL := /usr/bin/env bash
COMPOSE := docker compose
PNPM := pnpm

# Workspace filters
BACKEND := --filter @bbstat/backend
FRONTEND := --filter @bbstat/frontend

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@awk 'BEGIN { FS = ":.*##"; printf "\nUsage: make <target>\n\nTargets:\n" } \
		/^[a-zA-Z_-]+:.*##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# ---------------------------------------------------------------------------
# Container stack (compose.yaml + compose.override.yaml)
#
# Two workflows live side-by-side:
#   * Host hot-reload (`make dev`)         — needs only postgres + redis in
#                                            containers. Use `make up-deps`.
#   * Containerized parity (`make up`)     — full stack (pg, redis, traefik,
#                                            migrate, backend, sync, frontend)
#                                            served at https://bbstat.localhost.
# ---------------------------------------------------------------------------

.PHONY: up
up: env-init env-docker-init ## Start the full containerized stack (pg, redis, traefik, backend, sync, frontend)
	$(COMPOSE) up -d

.PHONY: up-deps
up-deps: env-init ## Start only postgres + redis (for the `make dev` host workflow)
	$(COMPOSE) up -d postgres redis

.PHONY: down
down: ## Stop the stack (preserves volumes)
	$(COMPOSE) down

.PHONY: reset
reset: ## Stop the stack AND drop volumes (wipes Postgres/Redis data)
	$(COMPOSE) down -v

.PHONY: ps
ps: ## Show service status
	$(COMPOSE) ps

.PHONY: logs
logs: ## Tail logs for all services
	$(COMPOSE) logs -f --tail=100

.PHONY: logs-pg
logs-pg: ## Tail logs for Postgres only
	$(COMPOSE) logs -f --tail=100 postgres

.PHONY: logs-redis
logs-redis: ## Tail logs for Redis only
	$(COMPOSE) logs -f --tail=100 redis

.PHONY: logs-backend
logs-backend: ## Tail logs for the backend container
	$(COMPOSE) logs -f --tail=100 backend

.PHONY: logs-frontend
logs-frontend: ## Tail logs for the frontend (nginx) container
	$(COMPOSE) logs -f --tail=100 frontend

.PHONY: logs-sync
logs-sync: ## Tail logs for the sync runner container
	$(COMPOSE) logs -f --tail=100 sync

.PHONY: logs-traefik
logs-traefik: ## Tail logs for the dev Traefik container
	$(COMPOSE) logs -f --tail=100 traefik

.PHONY: build-images
build-images: ## Build backend + frontend Docker images
	$(COMPOSE) build backend frontend

.PHONY: stack-migrate
stack-migrate: ## Run the one-shot Drizzle migrator against the stack's postgres
	$(COMPOSE) run --rm migrate

.PHONY: stack-rebuild
stack-rebuild: ## Rebuild images and restart the stack (use after code changes)
	$(COMPOSE) up -d --build

# ---------------------------------------------------------------------------
# Install / dev
# ---------------------------------------------------------------------------

.PHONY: install
install: env-init ## Install all workspace dependencies
	$(PNPM) install

# .env / .env.docker are auto-created from their respective .example files on
# first run. Declared as real file rules so the copy fires only when the
# target is missing.
.env:
	@cp .env.example .env
	@echo "→ Created .env from .env.example (edit it to add BitBucket credentials)"

.env.docker:
	@cp .env.docker.example .env.docker
	@echo "→ Created .env.docker from .env.docker.example (edit it to add BitBucket credentials)"

.PHONY: env-init
env-init: .env ## Bootstrap .env from .env.example if missing

.PHONY: env-docker-init
env-docker-init: .env.docker ## Bootstrap .env.docker from .env.docker.example if missing

.PHONY: dev
dev: env-init ## Run backend + frontend dev servers in parallel
	$(PNPM) dev

.PHONY: dev-backend
dev-backend: env-init ## Run backend dev server only
	$(PNPM) dev:backend

.PHONY: dev-frontend
dev-frontend: env-init ## Run frontend dev server only
	$(PNPM) dev:frontend

.PHONY: dev-sync
dev-sync: env-init ## Run the background sync runner (cron-mode stub)
	$(PNPM) $(BACKEND) run dev:sync

.PHONY: dev-resync
dev-resync: env-init ## One-shot anonymous-commit sweep — drains the author_user_id=NULL backlog; exits when done
	$(PNPM) $(BACKEND) run dev:resync

.PHONY: doctor
doctor: env-init ## Verify BitBucket credentials end-to-end against your workspace
	$(PNPM) $(BACKEND) run doctor

.PHONY: rebuild-rollups
rebuild-rollups: ## Re-aggregate commit_daily from commits (drift repair)
	$(PNPM) $(BACKEND) run rebuild:rollups

.PHONY: recompute-user-scores
recompute-user-scores: ## Force a ShipShow Score rollup (user_score table)
	$(PNPM) $(BACKEND) run recompute:user-scores

.PHONY: find-duplicates
find-duplicates: ## Find likely duplicate-account clusters for person-merge review (read-only)
	$(PNPM) $(BACKEND) run find:duplicates

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

.PHONY: test
test: ## Run all tests across both apps
	$(PNPM) test

.PHONY: test-backend
test-backend: ## Run backend tests only
	$(PNPM) $(BACKEND) run test

.PHONY: test-frontend
test-frontend: ## Run frontend tests only
	$(PNPM) $(FRONTEND) run test

.PHONY: test-watch
test-watch: ## Run all tests in watch mode (parallel)
	$(PNPM) test:watch

.PHONY: test-watch-backend
test-watch-backend: ## Watch backend tests
	$(PNPM) $(BACKEND) run test:watch

.PHONY: test-watch-frontend
test-watch-frontend: ## Watch frontend tests
	$(PNPM) $(FRONTEND) run test:watch

# ---------------------------------------------------------------------------
# Quality gates (zero errors, zero warnings)
# ---------------------------------------------------------------------------

.PHONY: typecheck
typecheck: ## Typecheck both apps
	$(PNPM) typecheck

.PHONY: lint
lint: ## ESLint across the workspace
	$(PNPM) lint

.PHONY: lint-fix
lint-fix: ## ESLint with --fix
	$(PNPM) lint:fix

.PHONY: format
format: ## Prettier --write
	$(PNPM) format

.PHONY: format-check
format-check: ## Prettier --check (no changes)
	$(PNPM) format:check

.PHONY: check
check: typecheck lint format-check test ## Run every quality gate (CI-equivalent)

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

.PHONY: build
build: ## Production builds for both apps
	$(PNPM) build

.PHONY: build-backend
build-backend: ## Production build for backend only
	$(PNPM) $(BACKEND) run build

.PHONY: build-frontend
build-frontend: ## Production build for frontend only
	$(PNPM) $(FRONTEND) run build

# ---------------------------------------------------------------------------
# Database (Drizzle)
# ---------------------------------------------------------------------------

.PHONY: db-generate
db-generate: ## Generate SQL migrations from schema diff
	$(PNPM) $(BACKEND) run db:generate

.PHONY: db-migrate
db-migrate: ## Apply pending migrations
	$(PNPM) $(BACKEND) run db:migrate

.PHONY: db-studio
db-studio: ## Open Drizzle Studio
	$(PNPM) $(BACKEND) run db:studio

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

.PHONY: clean
clean: ## Remove build outputs and caches (keeps node_modules)
	rm -rf apps/*/dist apps/*/build apps/*/coverage apps/*/.vite apps/*/*.tsbuildinfo

.PHONY: clean-deps
clean-deps: ## Remove all node_modules and the lockfile (forces a fresh install)
	rm -rf node_modules apps/*/node_modules pnpm-lock.yaml
