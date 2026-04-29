"""FastAPI application entry point.

In v1 the server is a license + metadata API only — encryption happens on
institute-owned machines via the SVP Encryptor desktop app, and the
encrypted .svf files are hosted by the institute (Google Drive, etc.).
The legacy embedded arq worker has been removed.

Run: python -m uvicorn app.main:app --port 8000
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.config import settings
from app.core.redis import close_redis, init_redis


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown — Redis only, no embedded worker."""
    await init_redis()
    print("Redis connected")

    yield

    await close_redis()
    print("Server shut down")


app = FastAPI(
    title="Secure Video Platform API",
    version="0.1.0",
    description="License + metadata server for the Secure Video Platform",
    lifespan=lifespan,
)

# CORS — localhost origins are always allowed for dev; additional production
# origins (e.g. the live dashboard URL) come from the ALLOWED_ORIGINS env var
# as a comma-separated list.
_default_origins = [
    # Tauri production builds on Windows (WebView2 custom protocol)
    "https://tauri.localhost",
    # Tauri production builds on macOS / Linux
    "tauri://localhost",
    # Tauri player dev server (Vite default)
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    # Tauri encryptor dev server — admin surface lives here in v1.5
    "http://localhost:1421",
    "http://127.0.0.1:1421",
    # Master dashboard (dev) — Next.js on port 3002
    "http://localhost:3002",
    "http://127.0.0.1:3002",
    # NOTE: the legacy tenant web dashboard on :3000 was removed in v1.5;
    # all tenant-admin operations now live inside the encryptor app.
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
    # Range-related headers were needed by the legacy /api/admin/videos/.../download
    # endpoint that streamed .svf files. The endpoint is gone in v1 (institutes
    # host their own files), but we keep these for forward compatibility with
    # any future server-hosted file flow (e.g. signed redirect endpoints).
    expose_headers=[
        "Content-Disposition",
        "Content-Length",
        "Content-Range",
        "Accept-Ranges",
    ],
)

app.include_router(api_router)


@app.get("/health")
async def health_check():
    return {"status": "ok", "version": "0.1.0"}
