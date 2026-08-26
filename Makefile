SHELL := /bin/bash
.PHONY: help dev fmt lint lint-sizes test plugin-test plugin-lint \
        service-test service-lint plugin-build service-run gen-types \
        create-module clean

PLUGIN_DIR := plugin
SERVICE_DIR := service

help:
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n",$$1,$$2}'

dev: ## install all dev dependencies
	cd $(PLUGIN_DIR) && npm ci
	cd $(SERVICE_DIR) && uv venv && uv pip install -e ".[dev,memory]"

fmt: ## auto-format everything
	cd $(PLUGIN_DIR) && npx biome format --write src tests *.json
	cd $(SERVICE_DIR) && uv run ruff format .

lint: plugin-lint service-lint lint-sizes ## run all linters

lint-sizes: ## enforce the 999-line file cap
	bash scripts/check_file_sizes.sh

plugin-lint:
	cd $(PLUGIN_DIR) && npx biome check src tests

service-lint:
	cd $(SERVICE_DIR) && uv run ruff check .

test: plugin-test service-test ## run all tests

plugin-test:
	cd $(PLUGIN_DIR) && npx vitest run

service-test:
	cd $(SERVICE_DIR) && uv run pytest -q

plugin-build: ## compile the plugin
	cd $(PLUGIN_DIR) && npm run build

gen-types: ## regenerate plugin TS types from the service OpenAPI spec
	cd $(SERVICE_DIR) && uv run python ../scripts/dump_openapi.py /tmp/openark-openapi.json
	cd $(PLUGIN_DIR) && npx openapi-typescript /tmp/openark-openapi.json -o src/generated/api-types.ts

service-run: ## start the API locally (127.0.0.1:8765)
	cd $(SERVICE_DIR) && uv run uvicorn openark.app:app --reload --host 127.0.0.1 --port 8765

create-module: ## scaffold a new module: make create-module name=foo
	node scripts/create_module.mjs $(name)

clean:
	rm -rf $(PLUGIN_DIR)/dist $(PLUGIN_DIR)/node_modules \
	       $(SERVICE_DIR)/.venv $(SERVICE_DIR)/.pytest_cache \
	       $(SERVICE_DIR)/.ruff_cache
