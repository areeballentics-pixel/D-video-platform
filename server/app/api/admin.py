"""Admin endpoints — video upload, encryption pipeline, student management.

These endpoints are restricted to users with role="admin".
"""

import json
import uuid
from pathlib import Path

import aiofiles
from arq import ArqRedis, create_pool
from arq.connections import RedisSettings
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.config import settings
from app.core.security import decrypt_master_key
from app.database import get_db
from app.models.device import Device
from app.models.license import License
from app.models.tenant import Tenant
from app.models.user import User
from app.models.video import Video
from app.core.security import hash_password

router = APIRouter()

UPLOAD_DIR = Path(__file__).parent.parent.parent / "uploads"
ENCRYPTED_DIR = Path(__file__).parent.parent.parent / "encrypted"


def require_admin(user: User = Depends(get_current_user)) -> User:
    """Dependency that ensures the user is an admin."""
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return user


async def get_arq_pool() -> ArqRedis:
    """Get an arq Redis pool for enqueuing jobs."""
    return await create_pool(RedisSettings.from_dsn(settings.REDIS_URL))


# ─── Video Upload & Encryption ───

@router.post("/videos/upload")
async def upload_video(
    file: UploadFile = File(...),
    title: str = Form(...),
    qualities: str = Form("480p,720p,1080p"),
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """Upload a raw video file and start the encryption pipeline.

    The video is saved to disk, then an async job is queued to:
    1. Transcode to requested qualities (FFmpeg)
    2. Encrypt with AES-256-CTR
    3. Package into .svf files
    4. Register in the database
    """
    # Validate file type
    allowed_extensions = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm"}
    ext = Path(file.filename or "").suffix.lower()
    if ext not in allowed_extensions:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type: {ext}. Allowed: {', '.join(allowed_extensions)}",
        )

    # Generate IDs
    video_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    safe_filename = f"{job_id}{ext}"

    # Save uploaded file to disk
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    upload_path = UPLOAD_DIR / safe_filename

    async with aiofiles.open(upload_path, "wb") as f:
        while chunk := await file.read(1_048_576):  # 1 MiB chunks
            await f.write(chunk)

    file_size = upload_path.stat().st_size

    # Get tenant master key
    result = await session.execute(
        select(Tenant).where(Tenant.id == user.tenant_id)
    )
    tenant = result.scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    master_key_hex = decrypt_master_key(tenant.master_key).hex()

    # Parse qualities
    quality_list = [q.strip() for q in qualities.split(",") if q.strip() in ("480p", "720p", "1080p")]
    if not quality_list:
        quality_list = ["480p", "720p", "1080p"]

    # Enqueue encryption job
    pool = await get_arq_pool()
    await pool.enqueue_job(
        "encrypt_video_job",
        job_id=job_id,
        video_id=video_id,
        tenant_id=str(user.tenant_id),
        title=title,
        input_filename=safe_filename,
        qualities=quality_list,
        master_key_hex=master_key_hex,
    )
    await pool.close()

    # Store initial status
    from app.core.redis import get_redis
    redis = get_redis()
    await redis.set(f"job:{job_id}:status", json.dumps({
        "status": "queued",
        "progress": 0,
        "detail": "Waiting in queue...",
    }), ex=86400)

    return {
        "job_id": job_id,
        "video_id": video_id,
        "filename": file.filename,
        "file_size": file_size,
        "qualities": quality_list,
        "message": "Upload complete. Encryption job queued.",
    }


@router.get("/videos/jobs/{job_id}")
async def get_job_status(
    job_id: str,
    user: User = Depends(require_admin),
):
    """Get the current status of an encryption job."""
    from app.core.redis import get_redis
    redis = get_redis()

    status_data = await redis.get(f"job:{job_id}:status")
    if not status_data:
        raise HTTPException(status_code=404, detail="Job not found")

    job_status = json.loads(status_data)

    # If completed, also return the result
    if job_status["status"] == "completed":
        result_data = await redis.get(f"job:{job_id}:result")
        if result_data:
            job_status["result"] = json.loads(result_data)

    return {"job_id": job_id, **job_status}


@router.post("/videos/jobs/{job_id}/register")
async def register_completed_video(
    job_id: str,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """Register a completed encryption job's video in the database.

    Call this after the job status is 'completed' to make the video
    available for licensing and playback.
    """
    from app.core.redis import get_redis
    redis = get_redis()

    result_data = await redis.get(f"job:{job_id}:result")
    if not result_data:
        raise HTTPException(status_code=404, detail="Job result not found")

    result = json.loads(result_data)

    # Check if already registered
    vid = uuid.UUID(result["video_id"])
    existing = await session.execute(select(Video).where(Video.id == vid))
    if existing.scalar_one_or_none():
        return {"message": "Video already registered", "video_id": result["video_id"]}

    # Use the first quality's encryption params for the database record
    first_quality = list(result["qualities"].values())[0]

    video = Video(
        id=vid,
        tenant_id=uuid.UUID(result["tenant_id"]),
        title=result["title"],
        description="",
        qualities=list(result["qualities"].keys()),
        encryption_salt=bytes.fromhex(first_quality["encryption_salt"]),
        encryption_nonce=bytes.fromhex(first_quality["encryption_nonce"]),
        duration_ms=result["duration_ms"],
    )
    session.add(video)
    await session.flush()

    return {
        "message": "Video registered",
        "video_id": result["video_id"],
        "title": result["title"],
    }


# ─── Video Management ───

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


@router.get("/videos/{video_id}/download/{quality}")
async def download_svf(
    video_id: str,
    quality: str,
    user: User = Depends(require_admin),
):
    """Download an encrypted .svf file."""
    filename = f"{video_id}_{quality}.svf"
    filepath = ENCRYPTED_DIR / filename

    if not filepath.exists():
        raise HTTPException(status_code=404, detail="SVF file not found")

    from fastapi.responses import FileResponse
    return FileResponse(
        path=str(filepath),
        filename=filename,
        media_type="application/octet-stream",
    )


@router.delete("/videos/{video_id}")
async def delete_video(
    video_id: str,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """Delete a video and its .svf files."""
    vid = uuid.UUID(video_id)
    result = await session.execute(
        select(Video).where(Video.id == vid, Video.tenant_id == user.tenant_id)
    )
    video = result.scalar_one_or_none()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    # Delete .svf files
    for quality in (video.qualities or []):
        svf_path = ENCRYPTED_DIR / f"{video_id}_{quality}.svf"
        svf_path.unlink(missing_ok=True)

    await session.delete(video)
    await session.flush()

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
    email: str = Form(...),
    password: str = Form(...),
    license_key: str = Form(None),
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """Create a new student account."""
    # Check email uniqueness within tenant
    existing = await session.execute(
        select(User).where(User.tenant_id == user.tenant_id, User.email == email)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already exists for this tenant")

    student = User(
        tenant_id=user.tenant_id,
        email=email,
        password_hash=hash_password(password),
        license_key=license_key or f"{uuid.uuid4().hex[:4].upper()}-{uuid.uuid4().hex[:4].upper()}-{uuid.uuid4().hex[:4].upper()}-{uuid.uuid4().hex[:4].upper()}",
        role="student",
    )
    session.add(student)
    # Must flush BEFORE creating the License so that SQLAlchemy assigns
    # student.id from the column default — otherwise the License row gets
    # user_id=NULL and the insert fails the FK constraint.
    await session.flush()

    # Create wildcard license (video_id NULL = access to all tenant videos)
    license = License(user_id=student.id, video_id=None)
    session.add(license)
    await session.flush()

    return {
        "user_id": str(student.id),
        "email": student.email,
        "license_key": student.license_key,
        "message": "Student created with full video access",
    }


@router.get("/students/{student_id}/devices")
async def get_student_devices(
    student_id: str,
    user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
):
    """View a student's registered devices."""
    sid = uuid.UUID(student_id)
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
    dev = uuid.UUID(device_id)
    result = await session.execute(
        select(Device).where(Device.id == dev, Device.user_id == uuid.UUID(student_id))
    )
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    device.is_active = False
    await session.flush()

    return {"message": "Device force-deregistered", "device_id": device_id}
