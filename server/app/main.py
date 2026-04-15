"""FastAPI application entry point.

The arq worker runs in a background thread inside this process.
One command runs everything: python -m uvicorn app.main:app --port 8000
"""

import threading
from contextlib import asynccontextmanager

from arq.worker import run_worker
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.config import settings
from app.core.redis import close_redis, init_redis


def _start_worker_thread():
    """Run arq worker in a separate thread with its own event loop.

    `handle_signals=False` is required on Linux: arq's default behaviour
    calls `loop.add_signal_handler()`, which fails in non-main threads
    with `set_wakeup_fd only works in main thread of the main interpreter`.
    Since the worker runs inside the FastAPI process and lifespan already
    handles shutdown via the daemon thread, arq doesn't need its own
    signal handlers.
    """
    import asyncio
    # Create a new event loop for this thread (required on Windows)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    from app.worker.settings import WorkerSettings
    run_worker(WorkerSettings, handle_signals=False)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: init Redis + start embedded arq worker. Shutdown: clean up."""
    await init_redis()
    print("Redis connected")

    # Start worker in a daemon thread (dies automatically when main process exits)
    worker_thread = threading.Thread(target=_start_worker_thread, daemon=True)
    worker_thread.start()
    print("Encryption worker started (background thread)")

    yield

    await close_redis()
    print("Server shut down")


app = FastAPI(
    title="Secure Video Platform API",
    version="0.1.0",
    description="License server for the Secure Video Player",
    lifespan=lifespan,
    max_upload_size=2_621_440_000,
)

# CORS — localhost origins are always allowed for dev; additional production
# origins (e.g. the live dashboard URL) come from the ALLOWED_ORIGINS env var
# as a comma-separated list.
_default_origins = [
    # Tauri player dev server
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "tauri://localhost",
    # Tenant admin dashboard (dev)
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    # Master dashboard (dev) — Next.js configured to port 3002
    "http://localhost:3002",
    "http://127.0.0.1:3002",
]
_extra_origins = [
    o.strip() for o in settings.ALLOWED_ORIGINS.split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_default_origins + _extra_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)


@app.get("/health")
async def health_check():
    return {"status": "ok", "version": "0.1.0"}
