"""Main API router — aggregates all sub-routers."""

from fastapi import APIRouter

from app.api import (
    admin,
    audit,
    auth,
    courses,
    devices,
    encryptor_updates,
    encryptors,
    enrollments,
    licenses,
    master,
    reports,
    student,
    tenant_settings,
    videos,
    watch,
)

api_router = APIRouter(prefix="/api")

# ── Tenant-user-facing ──
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(devices.router, prefix="/devices", tags=["devices"])
api_router.include_router(licenses.router, prefix="/licenses", tags=["licenses"])
api_router.include_router(student.router, prefix="/student", tags=["student"])
api_router.include_router(videos.router, prefix="/videos", tags=["videos"])
api_router.include_router(reports.router, prefix="/reports", tags=["reports"])
api_router.include_router(watch.router, prefix="/watch-events", tags=["watch-events"])

# ── Tenant-admin (require role="admin") ──
api_router.include_router(admin.router, prefix="/admin", tags=["admin"])
api_router.include_router(courses.router, prefix="/admin/courses", tags=["admin-courses"])
api_router.include_router(enrollments.router, prefix="/admin/enrollments", tags=["admin-enrollments"])
api_router.include_router(encryptors.router, prefix="/admin/encryptors", tags=["admin-encryptors"])
api_router.include_router(audit.router, prefix="/admin/audit", tags=["admin-audit"])
api_router.include_router(tenant_settings.router, prefix="/admin/tenant", tags=["admin-tenant-settings"])
api_router.include_router(watch.admin_router, prefix="/admin/analytics", tags=["admin-analytics"])

# ── Platform-admin (master) ──
api_router.include_router(master.router, prefix="/master", tags=["master"])

# ── Public: encryptor auto-updater (no auth) ──
api_router.include_router(
    encryptor_updates.router, prefix="/encryptor", tags=["encryptor-updates"]
)
