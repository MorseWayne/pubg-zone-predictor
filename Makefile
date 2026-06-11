SHELL := /bin/bash

.DEFAULT_GOAL := help

.PHONY: help setup setup-backend setup-frontend migrate backend frontend dev test build

help: ## Show available make targets.
	@awk 'BEGIN {FS = ":.*## "}; /^[a-zA-Z0-9_-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: setup-backend setup-frontend ## Install backend and frontend dependencies.

setup-backend: ## Install backend Python dependencies into .venv.
	python3 -m venv .venv
	.venv/bin/python -m pip install --upgrade pip
	.venv/bin/python -m pip install -e '.[dev]'

setup-frontend: ## Install frontend npm dependencies.
	env -u npm_config_allow_scripts -u NPM_CONFIG_ALLOW_SCRIPTS npm --prefix frontend install

migrate: ## Run database migrations.
	.venv/bin/python -m app.db.cli migrate

backend: ## Start the FastAPI backend dev server.
	npm run dev:backend

frontend: ## Start the Vite frontend dev server.
	npm run dev:frontend

dev: ## Start backend and frontend dev servers together.
	@set -e; \
	echo "Starting backend on http://127.0.0.1:8000"; \
	$(MAKE) --no-print-directory backend & backend_pid=$$!; \
	echo "Starting frontend on http://127.0.0.1:5173"; \
	$(MAKE) --no-print-directory frontend & frontend_pid=$$!; \
	trap 'kill $$backend_pid $$frontend_pid 2>/dev/null || true; wait 2>/dev/null || true' INT TERM EXIT; \
	wait -n $$backend_pid $$frontend_pid; \
	status=$$?; \
	kill $$backend_pid $$frontend_pid 2>/dev/null || true; \
	wait 2>/dev/null || true; \
	exit $$status

test: ## Run backend tests.
	npm run test:backend

build: ## Build the frontend.
	npm run build:frontend
