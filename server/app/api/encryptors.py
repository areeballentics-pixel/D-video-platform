"""Encryptor device lifecycle endpoints.

The institute admin's encryptor desktop app calls these:
  - /register      one-time, on first launch — returns master_key (re-auth required)
  - /refresh-key   on subsequent launches if keychain was wiped (re-auth required)
  - /ping          periodically to update last_seen_at (regular bearer token only)
  - /              list devices (for the dashboard)
  - /{id}          DELETE to revoke a device (frees a seat)

Plus tenant admin can ask for a seat upgrade:
  - /seat-upgrade-request   creates a SeatUpgradeRequest the master admin reviews
"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.security import decrypt_master_key, verify_password
from app.database import get_db
from app.models.encryptor_device import EncryptorDevice
from app.models.seat_upgrade_request import SeatUpgradeRequest, SEAT_REQUEST_PENDING
from app.models.tenant import Tenant
from app.models.user import User
from app.services.audit_service import write_audit


router = APIRouter()


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )


# ─── Schemas ────────────────────────────────────────────────────────────────

class EncryptorRegisterRequest(BaseModel):
    # Re-auth: caller's password (defense-in-depth — bearer token alone isn't
    # enough to obtain the master key).
    password: str
    fingerprint: str
    hostname: str
    os_version: str


class EncryptorRegisterResponse(BaseModel):
    encryptor_device_id: str
    master_key_hex: str
    seats_used: int
    seats_total: int
    is_first_registration: bool


class EncryptorRefreshKeyRequest(BaseModel):
    password: str
    encryptor_device_id: str
    fingerprint: str


class EncryptorRefreshKeyResponse(BaseModel):
    master_key_hex: str


class EncryptorDeviceOut(BaseModel):
    id: str
    fingerprint: str          # truncated for safety
    hostname: str
    os_version: str
    is_active: bool
    registered_at: str
    last_seen_at: str
    last_master_key_fetch_at: str


class EncryptorListResponse(BaseModel):
    devices: list[EncryptorDeviceOut]
    seats_used: int
    seats_total: int


class SeatUpgradeRequestIn(BaseModel):
    requested_seats: int
    notes: str = ""


# ─── Helpers ────────────────────────────────────────────────────────────────

async def _count_active_encryptor_devices(
    session: AsyncSession, tenant_id: uuid.UUID
) -> int:
    return await session.scalar(
        select(func.count())
        .select_from(EncryptorDevice)
        .where(
            EncryptorDevice.tenant_id == tenant_id,
            EncryptorDevice.is_active.is_(True),
        )
    ) or 0


def _to_out(d: EncryptorDevice) -> EncryptorDeviceOut:
    fp = d.fingerprint or ""
    truncated = (fp[:12] + "...") if len(fp) > 12 else fp
    return EncryptorDeviceOut(
        id=str(d.id),
        fingerprint=truncated,
        hostname=d.hostname,
        os_version=d.os_version,
        is_active=d.is_active,
        registered_at=d.registered_at.isoformat(),
        last_seen_at=d.last_seen_at.isoformat(),
        last_master_key_fetch_at=d.last_master_key_fetch_at.isoformat(),
    )


# ─── Endpoints ──────────────────────────────────────────────────────────────

@router.post("/register", response_model=EncryptorRegisterResponse)
async def register_encryptor(
    body: EncryptorRegisterRequest,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """One-time encryptor registration. Returns the tenant master_key in hex.

    Re-authentication via password is required even though the caller already
    has a bearer token — the master key never leaves the server without two
    factors of trust. The caller must store the key in their OS keychain and
    save an offline backup; the server returns it exactly once for new devices.
    """
    _require_admin(user)

    # Re-auth check — defends against stolen bearer tokens.
    if user.password_hash is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Password re-authentication failed",
        )

    tenant = (await session.execute(
        select(Tenant).where(Tenant.id == user.tenant_id)
    )).scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    # Idempotent: if this device fingerprint is already registered for the tenant,
    # update last_seen + last_master_key_fetch and return the master key without
    # consuming another seat.
    existing = (await session.execute(
        select(EncryptorDevice).where(
            EncryptorDevice.tenant_id == tenant.id,
            EncryptorDevice.fingerprint == body.fingerprint,
        )
    )).scalar_one_or_none()

    is_first = existing is None

    if existing is not None:
        if not existing.is_active:
            # Device was deregistered earlier. Allow re-activation only if
            # there's room under the seat cap.
            active = await _count_active_encryptor_devices(session, tenant.id)
            if active >= tenant.max_encryptor_devices:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=(
                        f"Encryptor seat cap reached ({active}/{tenant.max_encryptor_devices}). "
                        f"Deregister another device first or request a seat upgrade."
                    ),
                )
            existing.is_active = True
        existing.hostname = body.hostname
        existing.os_version = body.os_version
        existing.last_seen_at = datetime.now(timezone.utc)
        existing.last_master_key_fetch_at = datetime.now(timezone.utc)
        device = existing
    else:
        # New device — enforce seat cap.
        active = await _count_active_encryptor_devices(session, tenant.id)
        if active >= tenant.max_encryptor_devices:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=(
                    f"Encryptor seat cap reached ({active}/{tenant.max_encryptor_devices}). "
                    f"Deregister an existing device or contact support to upgrade."
                ),
            )
        device = EncryptorDevice(
            tenant_id=tenant.id,
            fingerprint=body.fingerprint,
            hostname=body.hostname,
            os_version=body.os_version,
            registered_by_user_id=user.id,
            is_active=True,
        )
        session.add(device)
        await session.flush()

    await session.commit()
    await session.refresh(device)

    master_key = decrypt_master_key(tenant.master_key)

    await write_audit(
        session,
        tenant_id=tenant.id,
        actor_type="tenant_admin",
        actor_id=str(user.id),
        actor_email=user.email,
        action="encryptor.register" if is_first else "encryptor.master_key_fetch",
        target_type="encryptor_device",
        target_id=str(device.id),
        details={
            "fingerprint_prefix": body.fingerprint[:12],
            "hostname": body.hostname,
            "is_first_registration": is_first,
        },
        request=request,
    )
    await session.commit()

    seats_used = await _count_active_encryptor_devices(session, tenant.id)
    return EncryptorRegisterResponse(
        encryptor_device_id=str(device.id),
        master_key_hex=master_key.hex(),
        seats_used=seats_used,
        seats_total=tenant.max_encryptor_devices,
        is_first_registration=is_first,
    )


@router.post("/refresh-key", response_model=EncryptorRefreshKeyResponse)
async def refresh_master_key(
    body: EncryptorRefreshKeyRequest,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Re-fetch the master key for an already-registered device. Used when the
    OS keychain was wiped or the user re-installed the encryptor app on the
    same machine. Re-auth required; does NOT consume a seat."""
    _require_admin(user)

    if user.password_hash is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Password re-authentication failed",
        )

    try:
        device_id = uuid.UUID(body.encryptor_device_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid encryptor_device_id")

    device = (await session.execute(
        select(EncryptorDevice).where(
            EncryptorDevice.id == device_id,
            EncryptorDevice.tenant_id == user.tenant_id,
        )
    )).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Encryptor device not found")
    if not device.is_active:
        raise HTTPException(status_code=403, detail="Encryptor device has been deregistered")
    if device.fingerprint != body.fingerprint:
        # Fingerprint mismatch → device is on a different machine. Reject.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Device fingerprint does not match the registered device",
        )

    tenant = (await session.execute(
        select(Tenant).where(Tenant.id == user.tenant_id)
    )).scalar_one()

    device.last_seen_at = datetime.now(timezone.utc)
    device.last_master_key_fetch_at = datetime.now(timezone.utc)
    await session.commit()

    master_key = decrypt_master_key(tenant.master_key)

    await write_audit(
        session,
        tenant_id=user.tenant_id,
        actor_type="tenant_admin",
        actor_id=str(user.id),
        actor_email=user.email,
        action="encryptor.master_key_fetch",
        target_type="encryptor_device",
        target_id=str(device.id),
        details={"reason": "refresh-key"},
        request=request,
    )
    await session.commit()

    return EncryptorRefreshKeyResponse(master_key_hex=master_key.hex())


@router.get("", response_model=EncryptorListResponse)
async def list_encryptor_devices(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    tenant = (await session.execute(
        select(Tenant).where(Tenant.id == user.tenant_id)
    )).scalar_one()

    devices = (await session.execute(
        select(EncryptorDevice)
        .where(EncryptorDevice.tenant_id == user.tenant_id)
        .order_by(EncryptorDevice.registered_at.desc())
    )).scalars().all()

    seats_used = sum(1 for d in devices if d.is_active)

    return EncryptorListResponse(
        devices=[_to_out(d) for d in devices],
        seats_used=seats_used,
        seats_total=tenant.max_encryptor_devices,
    )


@router.delete("/{device_id}")
async def deregister_encryptor(
    device_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Deactivate a device. Frees its seat under the tenant's cap."""
    _require_admin(user)
    try:
        did = uuid.UUID(device_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid device_id")

    device = (await session.execute(
        select(EncryptorDevice).where(
            EncryptorDevice.id == did,
            EncryptorDevice.tenant_id == user.tenant_id,
        )
    )).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Encryptor device not found")

    device.is_active = False
    await session.commit()

    await write_audit(
        session,
        tenant_id=user.tenant_id,
        actor_type="tenant_admin",
        actor_id=str(user.id),
        actor_email=user.email,
        action="encryptor.deregister",
        target_type="encryptor_device",
        target_id=str(device.id),
        details={"hostname": device.hostname},
        request=request,
    )
    await session.commit()

    return {"message": "Encryptor device deregistered", "device_id": device_id}


@router.post("/{device_id}/ping")
async def ping_encryptor(
    device_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Encryptor app calls this every few minutes while it's open, so the
    dashboard can show 'last seen 2 minutes ago' style indicators."""
    _require_admin(user)
    try:
        did = uuid.UUID(device_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid device_id")

    device = (await session.execute(
        select(EncryptorDevice).where(
            EncryptorDevice.id == did,
            EncryptorDevice.tenant_id == user.tenant_id,
            EncryptorDevice.is_active.is_(True),
        )
    )).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Active encryptor device not found")

    device.last_seen_at = datetime.now(timezone.utc)
    await session.commit()
    return {"ok": True, "last_seen_at": device.last_seen_at.isoformat()}


@router.post("/seat-upgrade-request")
async def request_seat_upgrade(
    body: SeatUpgradeRequestIn,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Tenant admin asks the platform admin for more encryptor seats. Creates a
    pending row in `seat_upgrade_requests` that the master dashboard surfaces."""
    _require_admin(user)
    if body.requested_seats < 1 or body.requested_seats > 50:
        raise HTTPException(status_code=400, detail="requested_seats must be 1-50")

    req = SeatUpgradeRequest(
        tenant_id=user.tenant_id,
        requested_by_user_id=user.id,
        requested_seats=body.requested_seats,
        notes=body.notes[:2000],
        status=SEAT_REQUEST_PENDING,
    )
    session.add(req)
    await session.commit()
    await session.refresh(req)

    await write_audit(
        session,
        tenant_id=user.tenant_id,
        actor_type="tenant_admin",
        actor_id=str(user.id),
        actor_email=user.email,
        action="encryptor.seat_upgrade_request",
        target_type="seat_upgrade_request",
        target_id=str(req.id),
        details={"requested_seats": body.requested_seats, "notes": body.notes[:200]},
        request=request,
    )
    await session.commit()

    return {
        "request_id": str(req.id),
        "status": req.status,
        "message": "Seat upgrade requested. The platform team will review shortly.",
    }
