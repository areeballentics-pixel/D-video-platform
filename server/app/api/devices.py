"""Device endpoints — listing and deregistration."""

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.database import get_db
from app.models.device import Device, DeviceChange
from app.models.user import User
from app.schemas.device import DeviceListResponse, DeviceResponse

router = APIRouter()


@router.get("/", response_model=DeviceListResponse)
async def list_devices(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """List the current user's registered (active) devices."""
    result = await session.execute(
        select(Device).where(
            Device.user_id == user.id, Device.is_active == True  # noqa: E712
        ).order_by(Device.registered_at.asc())
    )
    devices = result.scalars().all()

    device_responses = [
        DeviceResponse(
            device_id=str(d.id),
            fingerprint=d.fingerprint,
            hostname=d.hostname,
            os_version=d.os_version,
            is_active=d.is_active,
            registered_at=d.registered_at,
            last_seen_at=d.last_seen_at,
        )
        for d in devices
    ]

    return DeviceListResponse(
        devices=device_responses,
        devices_used=len(device_responses),
        max_devices=user.max_devices,
    )


@router.delete("/{device_id}")
async def deregister_device(
    device_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Deregister (deactivate) one of the current user's devices.

    Subject to the same cooldown as login device changes: max N changes per 30 days.
    """
    try:
        dev_uuid = uuid.UUID(device_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid device ID format",
        )

    # Load the device and verify ownership
    result = await session.execute(
        select(Device).where(
            Device.id == dev_uuid,
            Device.user_id == user.id,
            Device.is_active == True,  # noqa: E712
        )
    )
    device = result.scalar_one_or_none()
    if device is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Device not found or already deactivated",
        )

    # Check cooldown — count device changes in the last 30 days
    thirty_days_ago = datetime.now(timezone.utc) - timedelta(days=30)
    changes_result = await session.execute(
        select(func.count()).select_from(DeviceChange).where(
            DeviceChange.user_id == user.id,
            DeviceChange.changed_at >= thirty_days_ago,
        )
    )
    recent_changes = changes_result.scalar_one()

    if recent_changes >= user.max_device_changes_per_30d:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"Device change limit reached ({user.max_device_changes_per_30d} "
                f"changes per 30 days). Please try again later."
            ),
        )

    # Deactivate
    device.is_active = False
    session.add(DeviceChange(
        user_id=user.id,
        old_device_id=device.id,
        new_device_id=None,
    ))
    await session.flush()

    return {"message": "Device deregistered", "device_id": device_id}
