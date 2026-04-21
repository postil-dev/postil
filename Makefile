.PHONY: dev test lint typecheck build format install db-up db-down smoke

install:
	bun install

dev:
	bun run dev

build:
	bun run build

test:
	bun run test

lint:
	bun run lint

format:
	bun run format

typecheck:
	bun run typecheck

db-up:
	docker compose up -d postgres redis

db-down:
	docker compose down

smoke:
	@echo "Running first manual smoke test..."
	bun run typecheck && bun run lint && bun run test && bun run build
