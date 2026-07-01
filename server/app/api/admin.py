"""Admin endpoints — video flow, student management, tenant scoped operations.

These endpoints are restricted to users with role="admin".

The legacy upload + encryption-job + download endpoints (kept for compatibility
between Task #2 and Task #12) are scheduled for removal — they reference
columns that no longer exist on the Video model and will fail at runtime.
The v1 flow is: encryptor app calls POST /videos/register-encrypted with
metadata, then PUT /videos/{id}/download-urls once the institute has uploaded
the .svf to their Drive.
"""

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Request, status
from jose import jwt
from pydantic import BaseModel, Field
from sqlalchemy import select, func, delete as sa_delete, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.config import settings
from app.core.security import hash_password, verify_password
from app.database import get_db
from app.models.course import Course
from app.models.device import Device
from app.models.tenant import Tenant
from app.models.user import User
from app.models.video import VIDEO_STATUS_LIVE, VIDEO_STATUS_PENDING_URLS, Video
from app.models.watch_event import WatchEvent
from app.services.audit_service import write_audit
from app.services.auth_service import revoke_user_refresh_tokens
from app.utils.validation import is_valid_email

router = APIRouter()


def require_admin(user: User = Depends(get_current_user)) -> User:
    """Dependency that ensures the user is an admin."""
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return user


# ─── Video Management (server-side encryption removed in v1) ───
#
# In v1 the SVP Encryptor desktop app produces .svf files locally and
# registers them via /admin/videos/register-encrypted. The legacy upload +
# transcode + jobs + download endpoints have been deleted; their wired
# replacements live further down in this file.

@router.get("/videos")
async def list_videos(
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """List all videos for the admin's tenant."""
    result = await session.execute(
        select(Video).where(Video.tenant_id == user.tenant_id)
        .order_by(Video.created_at.desc())
    )
    videos = result.scalars().all()

    return {
        "videos": [
            {
                "video_id": str(v.id),
                "title": v.title,
                "qualities": v.qualities,
                "duration_ms": v.duration_ms,
                "created_at": v.created_at.isoformat(),
            }
            for v in videos
        ]
    }


@router.delete("/videos/{video_id}")
async def delete_video(
    video_id: str,
    request: Request,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """Delete a video.

    Note (v1 pivot): the server no longer stores .svf bytes — institutes host
    them on their own Drive — so there is nothing to unlink on disk. The old
    code referenced an undefined `ENCRYPTED_DIR` and raised NameError → 500
    (QA SP-003 / SP-014). We delete the DB row plus the dependent rows that
    don't cascade at the FK level: watch_events has no ON DELETE CASCADE, and a
    course intro pointer must be nulled. course_videos and watch_aggregates
    cascade automatically.
    """
    try:
        vid = uuid.UUID(video_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid video_id")

    result = await session.execute(
        select(Video).where(Video.id == vid, Video.tenant_id == user.tenant_id)
    )
    video = result.scalar_one_or_none()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    title = video.title
    qualities = list(video.qualities or [])

    # Remove dependent rows lacking ON DELETE CASCADE on videos.id.
    await session.execute(sa_delete(WatchEvent).where(WatchEvent.video_id == vid))
    await session.execute(
        sa_update(Course).where(Course.intro_video_id == vid).values(intro_video_id=None)
    )
    await session.delete(video)
    await session.commit()

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="video.delete", target_type="video", target_id=video_id,
        details={"title": title, "qualities": qualities}, request=request,
    )
    await session.commit()

    return {"message": "Video deleted", "video_id": video_id}


# ─── Student Management ───

@router.get("/students")
async def list_students(
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """List all students for the admin's tenant."""
    result = await session.execute(
        select(User).where(
            User.tenant_id == user.tenant_id,
            User.role == "student",
        ).order_by(User.created_at.desc())
    )
    students = result.scalars().all()

    student_list = []
    for s in students:
        # Count active devices
        dev_result = await session.execute(
            select(func.count()).select_from(Device).where(
                Device.user_id == s.id, Device.is_active == True  # noqa: E712
            )
        )
        device_count = dev_result.scalar_one()

        student_list.append({
            "user_id": str(s.id),
            "email": s.email,
            "license_key": s.license_key,
            "is_active": s.is_active,
            "max_devices": s.max_devices,
            "active_devices": device_count,
            "created_at": s.created_at.isoformat(),
        })

    return {"students": student_list}


@router.post("/students")
async def create_student(
    request: Request,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """Create a new student account.

    Accepts BOTH application/json and application/x-www-form-urlencoded, so a
    JSON-standardised client and the form-posting encryptor both work. (The
    rest of the admin API is JSON; create-student was the lone form-only
    outlier that returned a misleading 422 to JSON callers.)
    """
    ctype = request.headers.get("content-type", "")
    if "application/json" in ctype:
        data = await request.json()
    else:
        data = dict(await request.form())
    email = str(data.get("email") or "").strip()
    password = data.get("password")
    license_key = data.get("license_key")
    if not email or not password:
        raise HTTPException(status_code=422, detail="email and password are required")

    # Validate email format (AP-001 — same gate as tenant admin emails).
    if not is_valid_email(email):
        raise HTTPException(status_code=422, detail="Invalid email address")

    # Check email uniqueness within tenant
    existing = await session.execute(
        select(User).where(User.tenant_id == user.tenant_id, User.email == email)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already exists for this tenant")

    # ── Quota enforcement: count active students vs tenant.max_students ──
    # 402 Payment Required is the right semantic — "this is plan-driven,
    # contact your platform admin to upgrade", not "wait and retry".
    tenant = (await session.execute(
        select(Tenant).where(Tenant.id == user.tenant_id)
    )).scalar_one()
    current_students = await session.scalar(
        select(func.count())
        .select_from(User)
        .where(User.tenant_id == user.tenant_id, User.role == "student")
    ) or 0
    if current_students >= tenant.max_students:
        raise HTTPException(
            status_code=402,
            detail=(
                f"Student quota reached ({current_students}/{tenant.max_students}). "
                f"Contact your platform admin to raise the limit."
            ),
        )

    student = User(
        tenant_id=user.tenant_id,
        email=email,
        password_hash=hash_password(password),
        license_key=license_key or f"{uuid.uuid4().hex[:4].upper()}-{uuid.uuid4().hex[:4].upper()}-{uuid.uuid4().hex[:4].upper()}-{uuid.uuid4().hex[:4].upper()}",
        role="student",
    )
    session.add(student)
    await session.flush()

    # In v1, students start with no access. The admin must explicitly enroll
    # them in courses via POST /api/admin/enrollments (Task #3). The legacy
    # wildcard-license auto-creation has been removed.
    return {
        "user_id": str(student.id),
        "email": student.email,
        "license_key": student.license_key,
        "message": "Student created. Enroll them in one or more courses to grant video access.",
    }


@router.get("/students/{student_id}/devices")
async def get_student_devices(
    student_id: str,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """View a student's registered devices."""
    try:
        sid = uuid.UUID(student_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid student_id")

    # Tenant scoping: the student must belong to the caller's tenant. Without
    # this, a tenant admin could enumerate another tenant's device PII
    # (cross-tenant IDOR). Mirrors the reactivate/reset-password handlers.
    student = (await session.execute(
        select(User).where(
            User.id == sid, User.tenant_id == user.tenant_id, User.role == "student",
        )
    )).scalar_one_or_none()
    if student is None:
        raise HTTPException(status_code=404, detail="Student not found")

    result = await session.execute(
        select(Device).where(Device.user_id == sid).order_by(Device.registered_at.desc())
    )
    devices = result.scalars().all()

    return {
        "devices": [
            {
                "device_id": str(d.id),
                "fingerprint": d.fingerprint[:12] + "...",
                "hostname": d.hostname,
                "os_version": d.os_version,
                "is_active": d.is_active,
                "registered_at": d.registered_at.isoformat(),
                "last_seen_at": d.last_seen_at.isoformat(),
            }
            for d in devices
        ]
    }


@router.delete("/students/{student_id}/devices/{device_id}")
async def force_deregister_device(
    student_id: str,
    device_id: str,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """Admin force-deregister a student's device (no cooldown)."""
    try:
        sid = uuid.UUID(student_id)
        dev = uuid.UUID(device_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid id")

    # Tenant scoping: student must belong to the caller's tenant, else a tenant
    # admin could force-deregister another tenant's devices (cross-tenant IDOR).
    student = (await session.execute(
        select(User).where(
            User.id == sid, User.tenant_id == user.tenant_id, User.role == "student",
        )
    )).scalar_one_or_none()
    if student is None:
        raise HTTPException(status_code=404, detail="Student not found")

    result = await session.execute(
        select(Device).where(Device.id == dev, Device.user_id == sid)
    )
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    device.is_active = False
    await session.flush()

    return {"message": "Device force-deregistered", "device_id": device_id}


@router.post("/students/{student_id}/devices/{device_id}/reactivate")
async def reactivate_student_device(
    student_id: str,
    device_id: str,
    request: Request,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """Re-enable a previously deregistered device, subject to the student's
    device limit. Gives admins an explicit recovery path (QA SP-015) on top of
    the auto-reactivation that now also happens on the student's next login."""
    try:
        sid = uuid.UUID(student_id)
        dev = uuid.UUID(device_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid id")

    student = (await session.execute(
        select(User).where(
            User.id == sid, User.tenant_id == user.tenant_id, User.role == "student",
        )
    )).scalar_one_or_none()
    if student is None:
        raise HTTPException(status_code=404, detail="Student not found")

    device = (await session.execute(
        select(Device).where(Device.id == dev, Device.user_id == sid)
    )).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    if not device.is_active:
        active_count = await session.scalar(
            select(func.count()).select_from(Device).where(
                Device.user_id == sid, Device.is_active.is_(True)
            )
        ) or 0
        if active_count >= student.max_devices:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Device limit reached ({active_count}/{student.max_devices}). "
                    f"Deregister another device first."
                ),
            )
        device.is_active = True
        device.last_seen_at = datetime.now(timezone.utc)
        await session.commit()

        await write_audit(
            session, tenant_id=user.tenant_id, actor_type="tenant_admin",
            actor_id=str(user.id), actor_email=user.email,
            action="student.reactivate_device",
            target_type="device", target_id=device_id,
            request=request,
        )
        await session.commit()

    return {"message": "Device reactivated", "device_id": device_id, "is_active": True}


# ═══════════════════════════════════════════════════════════════════════════
# v1 endpoints: encryptor-side video registration + post-encryption flow
# ═══════════════════════════════════════════════════════════════════════════


class QualityEncryptionParams(BaseModel):
    salt: str = Field(..., min_length=64, max_length=64, pattern=r"^[0-9a-fA-F]{64}$")   # 32 bytes hex
    nonce: str = Field(..., min_length=32, max_length=32, pattern=r"^[0-9a-fA-F]{32}$")  # 16 bytes hex


class RegisterEncryptedVideoRequest(BaseModel):
    video_id: str                              # encryptor controls UUIDs
    title: str = Field(..., max_length=512)
    duration_ms: int = 0
    qualities: list[str]                       # e.g. ["720p"]
    encryption_params: dict[str, QualityEncryptionParams]
    content_hashes: dict[str, str]             # per-quality SHA-256 hex
    file_sizes: dict[str, int]                 # per-quality .svf size in bytes


class RegisterEncryptedVideoResponse(BaseModel):
    video_id: str
    status: str
    qualities: list[str]
    needs_download_urls_for: list[str]


@router.post("/videos/register-encrypted", response_model=RegisterEncryptedVideoResponse)
async def register_encrypted_video(
    body: RegisterEncryptedVideoRequest,
    request: Request,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """Encryptor desktop app reports a finished encryption job. Server stores
    the metadata; the institute then uploads the .svf to their Drive and
    pastes the URLs via PUT /videos/{id}/download-urls.

    Idempotent: if a Video row with this ID already exists for the tenant,
    the new qualities are merged into existing JSONB maps rather than replaced.
    """
    try:
        vid = uuid.UUID(body.video_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid video_id (must be UUID)")

    # Validate per-quality coverage.
    missing = [q for q in body.qualities if q not in body.encryption_params]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"encryption_params missing for qualities: {missing}",
        )

    existing = (await session.execute(
        select(Video).where(Video.id == vid)
    )).scalar_one_or_none()

    # ── Video quota enforcement (only on NEW videos, not re-registrations) ──
    if existing is None:
        tenant = (await session.execute(
            select(Tenant).where(Tenant.id == user.tenant_id)
        )).scalar_one()
        current_videos = await session.scalar(
            select(func.count())
            .select_from(Video)
            .where(Video.tenant_id == user.tenant_id)
        ) or 0
        if current_videos >= tenant.max_videos:
            raise HTTPException(
                status_code=402,
                detail=(
                    f"Video quota reached ({current_videos}/{tenant.max_videos}). "
                    f"Contact your platform admin to raise the limit."
                ),
            )

    if existing is not None:
        if existing.tenant_id != user.tenant_id:
            raise HTTPException(status_code=403, detail="video_id collision with another tenant")
        video = existing
        # Merge: each quality is independent metadata; overwrite if re-registered.
        params_map = dict(video.encryption_params or {})
        hashes_map = dict(video.content_hashes or {})
        sizes_map = dict(video.file_sizes or {})
        urls_map = dict(video.download_urls or {})
        qualities_list = list(video.qualities or [])
    else:
        video = Video(
            id=vid,
            tenant_id=user.tenant_id,
            title=body.title,
            description="",
            duration_ms=body.duration_ms,
            status=VIDEO_STATUS_PENDING_URLS,
        )
        session.add(video)
        params_map = {}
        hashes_map = {}
        sizes_map = {}
        urls_map = {}
        qualities_list = []

    # Merge per-quality entries.
    for q in body.qualities:
        ep = body.encryption_params[q]
        params_map[q] = {"salt": ep.salt, "nonce": ep.nonce}
        if q in body.content_hashes:
            hashes_map[q] = body.content_hashes[q]
        if q in body.file_sizes:
            sizes_map[q] = int(body.file_sizes[q])
        if q not in qualities_list:
            qualities_list.append(q)

    video.qualities = qualities_list
    video.encryption_params = params_map
    video.content_hashes = hashes_map
    video.file_sizes = sizes_map

    # Title can be updated on subsequent registrations (re-encrypt).
    if body.title:
        video.title = body.title
    if body.duration_ms:
        video.duration_ms = body.duration_ms

    # Status: live immediately on registration. download_urls are now purely
    # optional metadata — institutes can distribute the .svf via Drive (URL),
    # pendrive, email, internal share, etc. The player tries the URL if set,
    # otherwise expects the file to be in the local library folder.
    # `needs_urls` is still computed below as a hint for the awaiting-upload
    # screen, but it's no longer a status gate.
    needs_urls = [q for q in qualities_list if q not in urls_map]
    video.status = VIDEO_STATUS_LIVE

    await session.commit()
    await session.refresh(video)

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="video.register_encrypted",
        target_type="video", target_id=str(video.id),
        details={"title": video.title, "qualities": body.qualities},
        request=request,
    )
    await session.commit()

    return RegisterEncryptedVideoResponse(
        video_id=str(video.id),
        status=video.status,
        qualities=qualities_list,
        needs_download_urls_for=needs_urls,
    )


class DownloadUrlsRequest(BaseModel):
    # Per-quality URL map. Keys must be among the video's existing qualities.
    download_urls: dict[str, str]


@router.put("/videos/{video_id}/download-urls")
async def put_download_urls(
    video_id: str,
    body: DownloadUrlsRequest,
    request: Request,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """Paste Drive URLs after the institute uploads the .svf files.
    Flips status → live once every encrypted quality has a URL."""
    try:
        vid = uuid.UUID(video_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid video_id")

    video = (await session.execute(
        select(Video).where(Video.id == vid, Video.tenant_id == user.tenant_id)
    )).scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")

    # Validate basic URL shape — institutes self-host; we don't fetch them but
    # we want to catch obvious typos at the dashboard layer.
    for q, url in body.download_urls.items():
        if not (url.startswith("https://") or url.startswith("http://")):
            raise HTTPException(
                status_code=400,
                detail=f"download_urls['{q}'] must be an http(s) URL",
            )

    urls = dict(video.download_urls or {})
    urls.update(body.download_urls)
    video.download_urls = urls

    # Status stays `live` regardless — URLs are optional. needs_urls is just
    # a hint for the encryptor's distribution screen.
    needs_urls = [q for q in (video.qualities or []) if q not in urls]
    if video.status != VIDEO_STATUS_LIVE:
        video.status = VIDEO_STATUS_LIVE

    await session.commit()
    await session.refresh(video)

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="video.set_download_urls",
        target_type="video", target_id=str(video.id),
        details={"qualities_set": list(body.download_urls.keys()), "status": video.status},
        request=request,
    )
    await session.commit()

    return {
        "video_id": str(video.id),
        "status": video.status,
        "download_urls": video.download_urls,
        "needs_download_urls_for": needs_urls,
    }


class VideoUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    is_free_preview: Optional[bool] = None
    is_stream_only: Optional[bool] = None
    chapters: Optional[list[dict]] = None
    transcript_url: Optional[str] = None


@router.patch("/videos/{video_id}")
async def update_video(
    video_id: str,
    body: VideoUpdate,
    request: Request,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """Update video metadata and flags (free_preview, stream_only, chapters, transcript)."""
    try:
        vid = uuid.UUID(video_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid video_id")

    video = (await session.execute(
        select(Video).where(Video.id == vid, Video.tenant_id == user.tenant_id)
    )).scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")

    if body.title is not None:
        video.title = body.title
    if body.description is not None:
        video.description = body.description
    if body.is_free_preview is not None:
        video.is_free_preview = body.is_free_preview
    if body.is_stream_only is not None:
        video.is_stream_only = body.is_stream_only
    if body.chapters is not None:
        video.chapters = body.chapters
    if body.transcript_url is not None:
        video.transcript_url = body.transcript_url or None

    await session.commit()
    await session.refresh(video)

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="video.update", target_type="video", target_id=str(video.id),
        details=body.model_dump(exclude_none=True),
        request=request,
    )
    await session.commit()

    return {
        "video_id": str(video.id),
        "title": video.title,
        "is_free_preview": video.is_free_preview,
        "is_stream_only": video.is_stream_only,
        "chapters": video.chapters,
        "transcript_url": video.transcript_url,
    }


# ═══════════════════════════════════════════════════════════════════════════
# v1 endpoints: student management extras
# ═══════════════════════════════════════════════════════════════════════════


class ResetPasswordRequest(BaseModel):
    new_password: str = Field(..., min_length=8, max_length=200)


@router.post("/students/{student_id}/reset-password")
async def reset_student_password(
    student_id: str,
    body: ResetPasswordRequest,
    request: Request,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """Admin sets a new password for a student. Clears lockout state too."""
    try:
        sid = uuid.UUID(student_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid student_id")

    student = (await session.execute(
        select(User).where(
            User.id == sid,
            User.tenant_id == user.tenant_id,
            User.role == "student",
        )
    )).scalar_one_or_none()
    if student is None:
        raise HTTPException(status_code=404, detail="Student not found")

    student.password_hash = hash_password(body.new_password)
    student.failed_login_attempts = 0
    student.locked_until = None
    # QA SP-001: end every existing session for this student. Bumping
    # tokens_valid_from invalidates already-issued access tokens (they carry an
    # earlier `iat`), and purging the Redis refresh tokens stops new ones from
    # being minted. The student must log in again with the new password.
    student.tokens_valid_from = datetime.now(timezone.utc)
    await session.commit()

    revoked = await revoke_user_refresh_tokens(student.id)

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="student.reset_password",
        target_type="user", target_id=str(student.id),
        details={"sessions_revoked": revoked},
        request=request,
    )
    await session.commit()

    return {
        "message": "Password reset",
        "user_id": str(student.id),
        "email": student.email,
        "sessions_ended": True,
    }


class StudentUpdate(BaseModel):
    is_active: Optional[bool] = None
    max_devices: Optional[int] = Field(None, ge=1, le=10)
    admin_notes: Optional[str] = Field(None, max_length=5000)


@router.patch("/students/{student_id}")
async def update_student(
    student_id: str,
    body: StudentUpdate,
    request: Request,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    try:
        sid = uuid.UUID(student_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid student_id")

    student = (await session.execute(
        select(User).where(
            User.id == sid,
            User.tenant_id == user.tenant_id,
            User.role == "student",
        )
    )).scalar_one_or_none()
    if student is None:
        raise HTTPException(status_code=404, detail="Student not found")

    if body.is_active is not None:
        student.is_active = body.is_active
    if body.max_devices is not None:
        student.max_devices = body.max_devices
    if body.admin_notes is not None:
        student.admin_notes = body.admin_notes
    await session.commit()

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="student.update",
        target_type="user", target_id=str(student.id),
        details=body.model_dump(exclude_none=True),
        request=request,
    )
    await session.commit()
    return {
        "user_id": str(student.id),
        "is_active": student.is_active,
        "max_devices": student.max_devices,
        "admin_notes": student.admin_notes,
    }


@router.post("/students/{student_id}/devices/clear")
async def clear_student_devices(
    student_id: str,
    request: Request,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """Deregister ALL of a student's devices in one call. 'Lost my phone' flow."""
    try:
        sid = uuid.UUID(student_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid student_id")

    # Tenant scoping: student must belong to the caller's tenant, else a tenant
    # admin could wipe another tenant's devices / lock out their students
    # (cross-tenant IDOR).
    student = (await session.execute(
        select(User).where(
            User.id == sid, User.tenant_id == user.tenant_id, User.role == "student",
        )
    )).scalar_one_or_none()
    if student is None:
        raise HTTPException(status_code=404, detail="Student not found")

    devices = (await session.execute(
        select(Device).where(Device.user_id == sid, Device.is_active.is_(True))
    )).scalars().all()
    count = 0
    for d in devices:
        d.is_active = False
        count += 1
    await session.commit()

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="student.clear_devices",
        target_type="user", target_id=student_id,
        details={"deregistered_count": count}, request=request,
    )
    await session.commit()
    return {"message": "Cleared", "deregistered_count": count}


@router.post("/students/{student_id}/login-as")
async def login_as_student(
    student_id: str,
    request: Request,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """Generate a 15-minute access token for the target student so the admin
    can preview the player as that student does. The token carries an
    `impersonator_id` claim — the dashboard SHOULD show a banner; the server
    audit-logs the impersonation regardless of frontend behavior.
    """
    try:
        sid = uuid.UUID(student_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid student_id")

    student = (await session.execute(
        select(User).where(
            User.id == sid,
            User.tenant_id == user.tenant_id,
            User.role == "student",
            User.is_active.is_(True),
        )
    )).scalar_one_or_none()
    if student is None:
        raise HTTPException(status_code=404, detail="Active student not found")

    now = datetime.now(timezone.utc)
    expire = now + timedelta(minutes=15)
    token = jwt.encode(
        {
            "sub": str(student.id),
            "tenant_id": str(student.tenant_id),
            "role": student.role,
            "iat": now,
            "exp": expire,
            "type": "access",
            "impersonator_id": str(user.id),
            "impersonator_email": user.email,
        },
        settings.JWT_SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="student.login_as",
        target_type="user", target_id=str(student.id),
        details={"target_email": student.email, "expires_at": expire.isoformat()},
        request=request,
    )
    await session.commit()

    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": 900,
        "impersonating": {
            "user_id": str(student.id),
            "email": student.email,
        },
    }
