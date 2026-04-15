# ─── Secure Video Player — Development Commands ───

# Paths
PLAYER_DIR = player
SERVER_DIR = server
TOOLS_DIR = tools

# ─── Infrastructure ───
.PHONY: infra-up infra-down

infra-up:
	docker compose up -d

infra-down:
	docker compose down

# ─── Player (Tauri) ───
.PHONY: player-dev player-build

player-dev:
	cd $(PLAYER_DIR) && npm run tauri dev

player-build:
	cd $(PLAYER_DIR) && npm run tauri build

# ─── Server (FastAPI) ───
.PHONY: server-dev server-migrate

server-dev:
	cd $(SERVER_DIR) && uvicorn app.main:app --reload --port 8000

server-migrate:
	cd $(SERVER_DIR) && alembic upgrade head

# ─── CLI Tools ───
.PHONY: encrypt

encrypt:
	cd $(TOOLS_DIR) && python -m encrypt.cli $(ARGS)

# ─── Full Dev Setup ───
.PHONY: setup

setup: infra-up
	cd $(PLAYER_DIR) && npm install
	cd $(SERVER_DIR) && pip install -e ".[dev]"
	cd $(TOOLS_DIR) && pip install -e ".[dev]"
	@echo "Setup complete. Run 'make server-migrate' to initialize the database."
