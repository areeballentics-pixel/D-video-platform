"""Key service — license validation and video decryption key derivation."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decrypt_master_key
from app.models.device import Device
from app.models.license import License
from app.models.tenant import Tenant
from app.models.user import User
from app.models.video import Video
from app.utils.crypto import derive_video_key

QUALITY_MAP = {"480p": 0, "720p": 1, "1080p": 2}


class LicenseInvalid(Exception):
    """Raised when the user does not have a valid license for the requested video."""
    pass


class DeviceMismatch(Exception):
    """Raised when the device fingerprint is not registered for the user."""
    pass


class VideoNotFound(Exception):
    """Raised when the requested video does not exist."""
    pass


async def validate_license(
    session: AsyncSession,
    user: User,
    video_id: uuid.UUID,
    device_fingerprint: str,
) -> bool:
    """
    Check that:
    1. The user has an active device matching the fingerprint.
    2. The user holds a valid (active, non-expired) license for the video
       (or a wildcard license with video_id=NULL).

    Returns True if valid, raises otherwise.
    """
    # Verify device
    device_result = await session.execute(
        select(Device).where(
            Device.user_id == user.id,
            Device.fingerprint == device_fingerprint,
            Device.is_active == True,  # noqa: E712
        )
    )
    device = device_result.scalar_one_or_none()
    if device is None:
        raise DeviceMismatch("Device not registered or inactive for this user")

    # Update last_seen
    device.last_seen_at = datetime.now(timezone.utc)

    # Check license — either specific to this video or a wildcard (video_id IS NULL)
    now = datetime.now(timezone.utc)
    license_result = await session.execute(
        select(License).where(
            License.user_id == user.id,
            License.is_active == True,  # noqa: E712
            (License.video_id == video_id) | (License.video_id.is_(None)),
            (License.expires_at.is_(None)) | (License.expires_at > now),
        )
    )
    license_row = license_result.scalar_one_or_none()
    if license_row is None:
        raise LicenseInvalid("No valid license for this video")

    return True


async def get_video_key(
    session: AsyncSession,
    user: User,
    video_id_str: str,
    quality: str,
    device_fingerprint: str,
) -> str:
    """
    Validate the license, load tenant master key, load video encryption params,
    derive the per-video key via HKDF, and return it as a hex string.
    """
    try:
        video_id = uuid.UUID(video_id_str)
    except ValueError:
        raise VideoNotFound("Invalid video ID format")

    quality_int = QUALITY_MAP.get(quality)
    if quality_int is None:
        raise ValueError(f"Unsupported quality: {quality}. Use 480p, 720p, or 1080p.")

    # Validate license + device
    await validate_license(session, user, video_id, device_fingerprint)

    # Load the video
    video_result = await session.execute(
        select(Video).where(Video.id == video_id)
    )
    video = video_result.scalar_one_or_none()
    if video is None:
        raise VideoNotFound("Video not found")

    # Ensure the video belongs to the user's tenant
    if video.tenant_id != user.tenant_id:
        raise LicenseInvalid("Video does not belong to your tenant")

    # Load the tenant to get the master key
    tenant_result = await session.execute(
        select(Tenant).where(Tenant.id == user.tenant_id)
    )
    tenant = tenant_result.scalar_one_or_none()
    if tenant is None:
        raise LicenseInvalid("Tenant not found")

    # Decrypt the master key
    master_key = decrypt_master_key(tenant.master_key)

    # Derive the per-video key
    derived_key = derive_video_key(
        master_key=master_key,
        salt=video.encryption_salt,
        video_id=video.id.bytes,
        tenant_id=tenant.id.bytes,
        quality=quality_int,
    )

    return derived_key.hex()


async def get_user_licensed_keys(
    session: AsyncSession,
    user: User,
) -> list[dict]:
    """
    Return a bundle of decryption keys for every video this user is licensed to.

    This is sent to the player on login so it can play any of the user's
    licensed videos fully offline — without ever holding the tenant master key.

    Each entry: ``{"video_id": <hex>, "quality": "480p"|"720p"|"1080p", "key": <hex>}``

    Notes:
    - Wildcard licenses (video_id IS NULL) include all of the tenant's videos.
    - Expired or inactive licenses are filtered out.
    - One entry per (video, quality) pair; the player picks the right one
      based on which `.svf` file the student opens.
    """
    # Active, non-expired licenses for this user
    now = datetime.now(timezone.utc)
    license_result = await session.execute(
        select(License).where(
            License.user_id == user.id,
            License.is_active == True,  # noqa: E712
            or_(License.expires_at.is_(None), License.expires_at > now),
        )
    )
    licenses = license_result.scalars().all()

    if not licenses:
        return []

    # Determine which videos to include
    has_wildcard = any(lic.video_id is None for lic in licenses)
    if has_wildcard:
        # User can access every video in the tenant
        videos_result = await session.execute(
            select(Video).where(Video.tenant_id == user.tenant_id)
        )
    else:
        # User has only specific licenses
        video_ids = [lic.video_id for lic in licenses if lic.video_id is not None]
        videos_result = await session.execute(
            select(Video).where(Video.id.in_(video_ids))
        )
    videos = videos_result.scalars().all()

    if not videos:
        return []

    # Decrypt the tenant master key once and derive every per-video key.
    # The master key never leaves this function — only the derived per-video
    # keys are sent to the client.
    tenant_result = await session.execute(
        select(Tenant).where(Tenant.id == user.tenant_id)
    )
    tenant = tenant_result.scalar_one()
    master_key = decrypt_master_key(tenant.master_key)

    bundle: list[dict] = []
    for video in videos:
        # `qualities` is a JSONB list like ["480p", "720p", "1080p"]
        for quality_str in (video.qualities or []):
            quality_int = QUALITY_MAP.get(quality_str)
            if quality_int is None:
                continue

            derived = derive_video_key(
                master_key=master_key,
                salt=video.encryption_salt,
                video_id=video.id.bytes,
                tenant_id=tenant.id.bytes,
                quality=quality_int,
            )

            bundle.append({
                "video_id": video.id.hex,  # 32 hex chars, no dashes
                "quality": quality_str,
                "key": derived.hex(),
            })

    return bundle
