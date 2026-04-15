"""Auth service — credential verification, device registration, token management."""

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.redis import get_redis
from app.core.security import (
    create_access_token,
    create_refresh_token,
    verify_password,
)
from app.models.device import Device, DeviceChange
from app.models.user import User


async def authenticate_user(
    session: AsyncSession, email: str, password: str
) -> User | None:
    """Verify email + password credentials. Returns the User or None."""
    result = await session.execute(
        select(User).where(User.email == email, User.is_active == True)  # noqa: E712
    )
    user = result.scalar_one_or_none()
    if user is None:
        return None
    if not user.password_hash:
        return None
    if not verify_password(password, user.password_hash):
        return None
    return user


async def authenticate_by_key(
    session: AsyncSession, license_key: str
) -> User | None:
    """Find an active user by their license key. Returns the User or None."""
    result = await session.execute(
        select(User).where(
            User.license_key == license_key, User.is_active == True  # noqa: E712
        )
    )
    return result.scalar_one_or_none()


async def register_device_on_login(
    session: AsyncSession,
    user: User,
    fingerprint: str,
    hostname: str = "",
    os_version: str = "",
) -> Device:
    """
    Auto-register a device during login.

    Rules:
    1. If the user already has an active device with the same fingerprint, update
       last_seen_at and return it.
    2. If the user has not reached max_devices, create a new device.
    3. If at the limit, check if device_changes in the last 30 days < max_device_changes_per_30d.
       If allowed, deactivate the oldest device and register the new one.
    4. Otherwise, raise an error.

    Returns the Device (existing or new).
    """
    # 1. Check for existing device with same fingerprint
    result = await session.execute(
        select(Device).where(
            Device.user_id == user.id,
            Device.fingerprint == fingerprint,
            Device.is_active == True,  # noqa: E712
        )
    )
    existing = result.scalar_one_or_none()
    if existing is not None:
        existing.last_seen_at = datetime.now(timezone.utc)
        # Refresh human-readable metadata on every login so a hostname
        # change (e.g. student renamed their PC) shows up in the admin UI.
        # Also fills in blanks for devices registered before the player
        # started sending these fields.
        if hostname and hostname != existing.hostname:
            existing.hostname = hostname
        if os_version and os_version != existing.os_version:
            existing.os_version = os_version
        await session.flush()
        return existing

    # Count active devices
    count_result = await session.execute(
        select(func.count()).select_from(Device).where(
            Device.user_id == user.id, Device.is_active == True  # noqa: E712
        )
    )
    active_count = count_result.scalar_one()

    # 2. Under the limit — just register
    if active_count < user.max_devices:
        new_device = Device(
            user_id=user.id,
            fingerprint=fingerprint,
            hostname=hostname,
            os_version=os_version,
        )
        session.add(new_device)
        await session.flush()

        # Record the change
        session.add(DeviceChange(
            user_id=user.id,
            old_device_id=None,
            new_device_id=new_device.id,
        ))
        await session.flush()
        return new_device

    # 3. At the limit — check cooldown
    thirty_days_ago = datetime.now(timezone.utc) - timedelta(days=30)
    changes_result = await session.execute(
        select(func.count()).select_from(DeviceChange).where(
            DeviceChange.user_id == user.id,
            DeviceChange.changed_at >= thirty_days_ago,
        )
    )
    recent_changes = changes_result.scalar_one()

    if recent_changes >= user.max_device_changes_per_30d:
        raise DeviceLimitExceeded(
            f"Device change limit reached ({user.max_device_changes_per_30d} changes "
            f"per 30 days). Please try again later."
        )

    # Deactivate the oldest active device
    oldest_result = await session.execute(
        select(Device)
        .where(Device.user_id == user.id, Device.is_active == True)  # noqa: E712
        .order_by(Device.registered_at.asc())
        .limit(1)
    )
    oldest_device = oldest_result.scalar_one()
    oldest_device.is_active = False

    # Register new device
    new_device = Device(
        user_id=user.id,
        fingerprint=fingerprint,
        hostname=hostname,
        os_version=os_version,
    )
    session.add(new_device)
    await session.flush()

    # Record the change
    session.add(DeviceChange(
        user_id=user.id,
        old_device_id=oldest_device.id,
        new_device_id=new_device.id,
    ))
    await session.flush()
    return new_device


async def create_tokens(user: User, session: AsyncSession) -> dict:
    """
    Create access + refresh JWT tokens for the user, and store the
    refresh token JTI in Redis so it can be invalidated on logout.

    Also includes a per-license key bundle so the player can play any of
    the user's licensed videos fully offline. The tenant master key is
    never sent — only derived per-video keys for content this user
    actually has a license for.

    Returns a dict with access_token, refresh_token, user_id, email,
    tenant_id, and licensed_video_keys.
    """
    access_token = create_access_token(
        user_id=str(user.id),
        tenant_id=str(user.tenant_id),
        role=user.role,
    )
    refresh_token = create_refresh_token(user_id=str(user.id))

    # Store refresh token in Redis for revocation tracking
    from app.core.security import verify_token as _decode
    refresh_payload = _decode(refresh_token)
    jti = refresh_payload["jti"]
    expire_seconds = settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400

    redis = get_redis()
    await redis.setex(f"refresh:{jti}", expire_seconds, str(user.id))

    # Build the per-license key bundle for offline playback.
    # Imported here to avoid circular imports between auth_service and key_service.
    from app.services.key_service import get_user_licensed_keys
    licensed_video_keys = await get_user_licensed_keys(session, user)

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "user_id": str(user.id),
        "email": user.email,
        "tenant_id": str(user.tenant_id),
        "licensed_video_keys": licensed_video_keys,
    }


class DeviceLimitExceeded(Exception):
    """Raised when a user has exhausted their device-change allowance."""
    pass
