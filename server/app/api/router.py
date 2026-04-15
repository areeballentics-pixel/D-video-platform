"""Main API router — aggregates all sub-routers."""

from fastapi import APIRouter

from app.api import admin, auth, devices, licenses, master, videos, reports

api_router = APIRouter(prefix="/api")

api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(devices.router, prefix="/devices", tags=["devices"])
api_router.include_router(licenses.router, prefix="/licenses", tags=["licenses"])
api_router.include_router(videos.router, prefix="/videos", tags=["videos"])
api_router.include_router(reports.router, prefix="/reports", tags=["reports"])
api_router.include_router(admin.router, prefix="/admin", tags=["admin"])
api_router.include_router(master.router, prefix="/master", tags=["master"])
