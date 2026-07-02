"""Key service — enrollment-based access control + per-video key derivation.

In v1, "having a license" means "being enrolled in at least one published
course that contains the video, OR the video is marked as a free preview".
The legacy `licenses` table has been dropped; access checks go through
Enrollment + CourseVideo joins.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decrypt_master_key
from app.models.course import Course, CourseVideo
from app.models.device import Device
from app.models.enrollment import Enrollment
from app.models.tenant import Tenant
from app.models.user import User
from app.models.video import Video
from app.utils.crypto import derive_video_key

# Quality int matches the SVF header's `quality` field (u16, little-endian).
# 65535 ("original") is the encryptor's fallback when MP4 dims don't match a
# standard bucket — keep this in sync with crates/svf-core/src/svf.rs and
# encryptor/src-tauri/src/pipeline.rs.
QUALITY_MAP = {"480p": 0, "720p": 1, "1080p": 2, "original": 65535}


class LicenseInvalid(Exception):
    """Raised when the user does not have a valid enrollment for the requested video."""
    pass


class DeviceMismatch(Exception):
    """Raised when the device fingerprint is not registered for the user."""
    pass


class VideoNotFound(Exception):
    """Raised when the requested video does not exist."""
    pass


async def _user_has_enrollment_access(
    session: AsyncSession,
    user_id: uuid.UUID,
    video_id: uuid.UUID,
) -> bool:
    """True if the user is enrolled (active, non-expired) in any published,
    non-archived course that contains this video."""
    now = datetime.now(timezone.utc)
    count = await session.scalar(
        select(func.count())
        .select_from(Enrollment)
        .join(CourseVideo, CourseVideo.course_id == Enrollment.course_id)
        .join(Course, Course.id == Enrollment.course_id)
        .where(
            Enrollment.user_id == user_id,
            Enrollment.is_active.is_(True),
            or_(Enrollment.expires_at.is_(None), Enrollment.expires_at > now),
            CourseVideo.video_id == video_id,
            Course.is_published.is_(True),
            Course.is_archived.is_(False),
        )
    )
    return bool(count and count > 0)


async def validate_license(
    session: AsyncSession,
    user: User,
    video_id: uuid.UUID,
    device_fingerprint: str,
) -> bool:
    """Verify device + video access. Returns True or raises.

    Access is granted if any of:
      - The video is marked is_free_preview=True
      - The user is enrolled in a published, non-archived course containing it
    """
    # ── Device check ──
    device = (await session.execute(
        select(Device).where(
            Device.user_id == user.id,
            Device.fingerprint == device_fingerprint,
            Device.is_active.is_(True),
        )
    )).scalar_one_or_none()
    if device is None:
        raise DeviceMismatch("Device not registered or inactive for this user")

    device.last_seen_at = datetime.now(timezone.utc)

    # ── Tenant kill-switch ──
    # A suspended/revoked tenant immediately cuts off ALL its students. Both
    # /api/videos/key (new plays) and /api/licenses/validate (the player's live
    # re-validation, SP-009/014) call this, so in-progress playback also stops
    # on the next check, not just new plays.
    tenant = await session.get(Tenant, user.tenant_id)
    if tenant is None or not tenant.is_active:
        raise LicenseInvalid("Your institute's access has been suspended. Contact your administrator.")

    # ── Video lookup ──
    video = await session.get(Video, video_id)
    if video is None:
        raise VideoNotFound("Video not found")
    if video.tenant_id != user.tenant_id:
        raise LicenseInvalid("Video does not belong to your tenant")

    # ── Access check ──
    if video.is_free_preview:
        return True

    if await _user_has_enrollment_access(session, user.id, video_id):
        return True

    raise LicenseInvalid("No active enrollment grants access to this video")


def _get_quality_salt(video: Video, quality_str: str) -> bytes | None:
    """Pull the per-quality salt out of `video.encryption_params`. Returns None
    if the quality hasn't been encrypted/registered yet."""
    params = (video.encryption_params or {}).get(quality_str)
    if not params:
        return None
    salt_hex = params.get("salt")
    if not salt_hex:
        return None
    try:
        return bytes.fromhex(salt_hex)
    except ValueError:
        return None


async def get_video_key(
    session: AsyncSession,
    user: User,
    video_id_str: str,
    quality: str,
    device_fingerprint: str,
) -> str:
    """Validate access, derive the per-(video, quality) key, return as hex."""
    try:
        video_id = uuid.UUID(video_id_str)
    except ValueError:
        raise VideoNotFound("Invalid video ID format")

    quality_int = QUALITY_MAP.get(quality)
    if quality_int is None:
        raise ValueError(f"Unsupported quality: {quality}. Use 480p, 720p, or 1080p.")

    await validate_license(session, user, video_id, device_fingerprint)

    video = (await session.execute(
        select(Video).where(Video.id == video_id)
    )).scalar_one_or_none()
    if video is None:
        raise VideoNotFound("Video not found")

    salt = _get_quality_salt(video, quality)
    if salt is None:
        raise VideoNotFound(f"Quality {quality} has not been encrypted for this video")

    tenant = (await session.execute(
        select(Tenant).where(Tenant.id == user.tenant_id)
    )).scalar_one_or_none()
    if tenant is None:
        raise LicenseInvalid("Tenant not found")

    master_key = decrypt_master_key(tenant.master_key)

    derived_key = derive_video_key(
        master_key=master_key,
        salt=salt,
        video_id=video.id.bytes,
        tenant_id=tenant.id.bytes,
        quality=quality_int,
    )

    return derived_key.hex()


async def get_user_licensed_keys(
    session: AsyncSession,
    user: User,
) -> list[dict]:
    """Bundle of (video_id, quality, key) entries for every video the user
    can play right now: enrolled-course videos + free-preview videos.

    Sent to the player on login so it can play any of those videos fully
    offline without ever holding the tenant master key.
    """
    now = datetime.now(timezone.utc)

    # Videos reachable via active enrollments to published courses.
    enrolled_videos_q = (
        select(Video)
        .join(CourseVideo, CourseVideo.video_id == Video.id)
        .join(Course, Course.id == CourseVideo.course_id)
        .join(Enrollment, Enrollment.course_id == Course.id)
        .where(
            Enrollment.user_id == user.id,
            Enrollment.is_active.is_(True),
            or_(Enrollment.expires_at.is_(None), Enrollment.expires_at > now),
            Course.is_published.is_(True),
            Course.is_archived.is_(False),
            Video.tenant_id == user.tenant_id,
        )
        .distinct()
    )

    # Free-preview videos in the user's tenant.
    free_videos_q = (
        select(Video).where(
            Video.tenant_id == user.tenant_id,
            Video.is_free_preview.is_(True),
        )
    )

    enrolled_videos = (await session.execute(enrolled_videos_q)).scalars().all()
    free_videos = (await session.execute(free_videos_q)).scalars().all()

    # De-dup by video_id (a free-preview video may also be in an enrolled course).
    by_id = {v.id: v for v in enrolled_videos}
    for v in free_videos:
        by_id.setdefault(v.id, v)
    videos = list(by_id.values())

    if not videos:
        return []

    tenant = (await session.execute(
        select(Tenant).where(Tenant.id == user.tenant_id)
    )).scalar_one()
    master_key = decrypt_master_key(tenant.master_key)

    bundle: list[dict] = []
    for video in videos:
        for quality_str in (video.qualities or []):
            quality_int = QUALITY_MAP.get(quality_str)
            if quality_int is None:
                continue

            salt = _get_quality_salt(video, quality_str)
            if salt is None:
                # Quality not yet encrypted/registered; skip — student will
                # see a clear error if they try to play it.
                continue

            derived = derive_video_key(
                master_key=master_key,
                salt=salt,
                video_id=video.id.bytes,
                tenant_id=tenant.id.bytes,
                quality=quality_int,
            )

            bundle.append({
                # DASHLESS hex — the shipped player matches licensed-bundle keys
                # on hex(video_id) (see player license.rs fetch_video_key). Do NOT
                # send a dashed UUID here or the offline bundle lookup breaks on
                # every deployed player. (Reverted the 102e168 "consistency" change.)
                "video_id": video.id.hex,
                "quality": quality_str,
                "key": derived.hex(),
            })

    return bundle
