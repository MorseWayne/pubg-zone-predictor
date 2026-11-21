SHELL := /bin/bash

.DEFAULT_GOAL := help

.PHONY: help setup setup-backend setup-frontend migrate backend frontend dev test build
.PHONY: check-backend check-frontend

help: ## Show available make targets.
	@awk 'BEGIN {FS = ":.*## "}; /^[a-zA-Z0-9_-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

ifeq ($(OS),Windows_NT)
    PYTHON_CMD := python
    VENV_BIN := .venv/Scripts
else
    PYTHON_CMD := python3
    VENV_BIN := .venv/bin
endif

FRONTEND_INSTALL_LOCK := frontend/node_modules/.package-lock.json

setup: setup-backend setup-frontend ## Install backend and frontend dependencies.

setup-backend: ## Install backend Python dependencies into .venv.
	$(PYTHON_CMD) -m venv .venv
	$(VENV_BIN)/python -m pip install --upgrade pip
	$(VENV_BIN)/python -m pip install -e '.[dev]'

setup-frontend: ## Install frontend npm dependencies.
	env -u npm_config_allow_scripts -u NPM_CONFIG_ALLOW_SCRIPTS npm --prefix frontend install --include=dev

migrate: ## Run database migrations.
	$(VENV_BIN)/python -m app.db.cli migrate

check-backend:
	@test -x "$(VENV_BIN)/uvicorn" || { echo "Missing backend dependency: uvicorn. Run 'make setup'." >&2; exit 1; }

check-frontend:
	@test -x frontend/node_modules/.bin/vite || { echo "Missing frontend dependency: vite. Run 'make setup'." >&2; exit 1; }

backend: check-backend ## Start the FastAPI backend dev server.
	$(VENV_BIN)/uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 --reload --reload-dir backend

frontend: check-frontend ## Start the Vite frontend dev server.
	npm run dev:frontend

dev: check-backend check-frontend ## Start backend and frontend dev servers together.
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
	$(VENV_BIN)/pytest backend/tests

# A production-only npm install also writes the hidden lockfile, but omits Vite.
ifeq ($(wildcard frontend/node_modules/.bin/vite),)
.PHONY: $(FRONTEND_INSTALL_LOCK)
endif

$(FRONTEND_INSTALL_LOCK): frontend/package.json frontend/package-lock.json
	env -u npm_config_allow_scripts -u NPM_CONFIG_ALLOW_SCRIPTS npm --prefix frontend ci --include=dev

build: $(FRONTEND_INSTALL_LOCK) ## Install dependencies as needed and build the frontend.
	npm run build:frontend
