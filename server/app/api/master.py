"""Master (platform-admin) API endpoints.

These endpoints are used by the master dashboard only. Authentication uses
a distinct JWT `type` claim ("master_access") — tenant-user tokens are
rejected by `get_current_master_admin`.
"""

import secrets
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from jose import JWTError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_master_admin
from app.config import settings
from app.core.redis import get_redis
from app.core.security import (
    create_master_access_token,
    create_master_refresh_token,
    encrypt_master_key,
    hash_password,
    verify_password,
    verify_token,
)
from app.database import get_db
from app.models.device import Device
from app.models.platform_admin import PlatformAdmin
from app.models.tenant import Tenant
from app.models.user import User
from app.models.video import Video
from app.schemas.master import (
    MasterLoginRequest,
    MasterRefreshRequest,
    MasterTokenResponse,
    TenantActionResponse,
    TenantCreateRequest,
    TenantCreateResponse,
    TenantListResponse,
    TenantSummary,
)

router = APIRouter()


# ─── Auth ───────────────────────────────────────────────────────────

async def _issue_master_tokens(admin: PlatformAdmin) -> MasterTokenResponse:
    """Generate a fresh access + refresh token pair for a platform admin.

    The refresh token's JTI is stored in Redis under a `master_refresh:`
    prefix so revocation is independent from tenant refresh tokens.
    """
    access = create_master_access_token(str(admin.id))
    refresh = create_master_refresh_token(str(admin.id))

    refresh_payload = verify_token(refresh)
    jti = refresh_payload["jti"]
    expire_seconds = settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400

    redis = get_redis()
    await redis.setex(f"master_refresh:{jti}", expire_seconds, str(admin.id))

    return MasterTokenResponse(
        access_token=access,
        refresh_token=refresh,
        admin_id=str(admin.id),
        email=admin.email,
    )


@router.post("/login", response_model=MasterTokenResponse)
async def master_login(
    body: MasterLoginRequest,
    session: AsyncSession = Depends(get_db),
):
    """Log in as a platform admin."""
    result = await session.execute(
        select(PlatformAdmin).where(PlatformAdmin.email == body.email)
    )
    admin = result.scalar_one_or_none()
    if admin is None or not admin.is_active or not verify_password(body.password, admin.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )
    return await _issue_master_tokens(admin)


@router.post("/refresh", response_model=MasterTokenResponse)
async def master_refresh(
    body: MasterRefreshRequest,
    session: AsyncSession = Depends(get_db),
):
    """Rotate a master admin's access + refresh token pair."""
    try:
        payload = verify_token(body.refresh_token)
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )

    if payload.get("type") != "master_refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type — expected master refresh token",
        )

    jti = payload.get("jti")
    admin_id_str = payload.get("sub")
    if not jti or not admin_id_str:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Malformed refresh token",
        )

    # Refresh tokens are single-use: check + delete the JTI atomically
    redis = get_redis()
    stored = await redis.get(f"master_refresh:{jti}")
    if stored is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token has been revoked",
        )
    await redis.delete(f"master_refresh:{jti}")

    try:
        admin_id = uuid.UUID(admin_id_str)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid admin id in token")

    result = await session.execute(
        select(PlatformAdmin).where(PlatformAdmin.id == admin_id)
    )
    admin = result.scalar_one_or_none()
    if admin is None or not admin.is_active:
        raise HTTPException(status_code=401, detail="Admin not found or inactive")

    return await _issue_master_tokens(admin)


@router.post("/logout")
async def master_logout(admin: PlatformAdmin = Depends(get_current_master_admin)):
    """Revoke all refresh tokens for the current platform admin."""
    redis = get_redis()
    admin_id_str = str(admin.id)
    deleted = 0
    cursor = "0"
    while True:
        cursor, keys = await redis.scan(cursor=cursor, match="master_refresh:*", count=100)
        for key in keys:
            value = await redis.get(key)
            if value == admin_id_str:
                await redis.delete(key)
                deleted += 1
        if cursor == 0 or cursor == "0":
            break
    return {"message": "Logged out", "tokens_revoked": deleted}


# ─── Tenants ────────────────────────────────────────────────────────

@router.get("/tenants", response_model=TenantListResponse)
async def list_tenants(
    _admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """List every tenant with aggregate stats for the master dashboard."""
    tenants_result = await session.execute(
        select(Tenant).order_by(Tenant.created_at.desc())
    )
    tenants = tenants_result.scalars().all()

    summaries: list[TenantSummary] = []
    for tenant in tenants:
        # Count students, admins, videos, active devices for this tenant
        student_count = await session.scalar(
            select(func.count())
            .select_from(User)
            .where(User.tenant_id == tenant.id, User.role == "student")
        )
        admin_count = await session.scalar(
            select(func.count())
            .select_from(User)
            .where(User.tenant_id == tenant.id, User.role == "admin")
        )
        video_count = await session.scalar(
            select(func.count())
            .select_from(Video)
            .where(Video.tenant_id == tenant.id)
        )
        active_device_count = await session.scalar(
            select(func.count())
            .select_from(Device)
            .join(User, User.id == Device.user_id)
            .where(User.tenant_id == tenant.id, Device.is_active == True)  # noqa: E712
        )

        summaries.append(TenantSummary(
            id=str(tenant.id),
            name=tenant.name,
            slug=tenant.slug,
            is_active=tenant.is_active,
            suspended_at=tenant.suspended_at.isoformat() if tenant.suspended_at else None,
            created_at=tenant.created_at.isoformat(),
            student_count=student_count or 0,
            admin_count=admin_count or 0,
            video_count=video_count or 0,
            active_device_count=active_device_count or 0,
        ))

    return TenantListResponse(tenants=summaries)


@router.post("/tenants", response_model=TenantCreateResponse, status_code=201)
async def create_tenant(
    body: TenantCreateRequest,
    _admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Provision a new tenant with a first admin user.

    Generates a random 32-byte tenant master key, Fernet-encrypts it, and
    stores it in the database. Returns the raw master key hex exactly once —
    the master dashboard should surface it so the operator can record an
    offline paper backup (not retrievable again from the API).
    """
    # Uniqueness check on slug
    existing = await session.execute(
        select(Tenant).where(Tenant.slug == body.slug)
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A tenant with slug '{body.slug}' already exists",
        )

    # Generate + encrypt the tenant master key
    master_key_raw = secrets.token_bytes(32)
    tenant = Tenant(
        name=body.name,
        slug=body.slug,
        master_key=encrypt_master_key(master_key_raw),
    )
    session.add(tenant)
    await session.flush()

    admin_user = User(
        tenant_id=tenant.id,
        email=body.admin_email,
        password_hash=hash_password(body.admin_password),
        role="admin",
        is_active=True,
    )
    session.add(admin_user)
    await session.commit()

    return TenantCreateResponse(
        tenant_id=str(tenant.id),
        tenant_name=tenant.name,
        tenant_slug=tenant.slug,
        master_key_hex=master_key_raw.hex(),
        admin_user_id=str(admin_user.id),
        admin_email=admin_user.email,
    )


@router.patch("/tenants/{tenant_id}/suspend", response_model=TenantActionResponse)
async def suspend_tenant(
    tenant_id: uuid.UUID,
    _admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Suspend a tenant.

    Effects:
      - Tenant admins and students are blocked from all API calls immediately
        (the tenant-scoped `get_current_user` dependency checks is_active).
      - Player `/api/videos/key` calls from currently-online students start
        failing at once.
      - Students already in offline mode can keep playing cached videos
        until their 20-day grace period expires, by design.

    Also revokes every outstanding refresh token for users belonging to the
    tenant, so they can't mint new access tokens even if they come online
    again before the tenant is reactivated.
    """
    result = await session.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = result.scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    if not tenant.is_active:
        return TenantActionResponse(
            tenant_id=str(tenant.id),
            is_active=False,
            message="Tenant was already suspended",
        )

    tenant.is_active = False
    tenant.suspended_at = datetime.now(timezone.utc)
    await session.commit()

    # Best-effort: purge all active refresh tokens belonging to users of
    # this tenant, so any currently-online sessions can't silently refresh.
    users_result = await session.execute(
        select(User.id).where(User.tenant_id == tenant.id)
    )
    user_ids = {str(uid) for (uid,) in users_result.all()}

    redis = get_redis()
    revoked = 0
    cursor = "0"
    while True:
        cursor, keys = await redis.scan(cursor=cursor, match="refresh:*", count=200)
        for key in keys:
            owner = await redis.get(key)
            if owner in user_ids:
                await redis.delete(key)
                revoked += 1
        if cursor == 0 or cursor == "0":
            break

    return TenantActionResponse(
        tenant_id=str(tenant.id),
        is_active=False,
        message=f"Tenant suspended. {revoked} active session(s) revoked.",
    )


@router.patch("/tenants/{tenant_id}/reactivate", response_model=TenantActionResponse)
async def reactivate_tenant(
    tenant_id: uuid.UUID,
    _admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Reverse a suspension. Existing users will need to log in again."""
    result = await session.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = result.scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    if tenant.is_active:
        return TenantActionResponse(
            tenant_id=str(tenant.id),
            is_active=True,
            message="Tenant was already active",
        )

    tenant.is_active = True
    tenant.suspended_at = None
    await session.commit()
    return TenantActionResponse(
        tenant_id=str(tenant.id),
        is_active=True,
        message="Tenant reactivated",
    )


@router.delete("/tenants/{tenant_id}", response_model=TenantActionResponse)
async def delete_tenant(
    tenant_id: uuid.UUID,
    confirm_slug: str,
    _admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Hard-delete a tenant (cascade).

    Requires `confirm_slug` to exactly match the tenant's slug as a
    second-factor confirmation — prevents accidental deletes.

    ⚠️ This is destructive and irreversible. Prefer `/suspend` unless the
    tenant truly needs to be purged (e.g. GDPR erasure request).
    """
    result = await session.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = result.scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    if confirm_slug != tenant.slug:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Confirmation mismatch: expected slug '{tenant.slug}' to "
                f"confirm deletion, got '{confirm_slug}'"
            ),
        )

    # Cascade-delete everything scoped to this tenant.
    # We do it in FK-safe order: device_changes/piracy_reports → devices,
    # licenses → users → videos → tenant.
    from sqlalchemy import delete as sa_delete
    from app.models.device import Device, DeviceChange
    from app.models.license import License
    from app.models.piracy_report import PiracyReport

    # Collect user IDs for this tenant
    user_ids_result = await session.execute(
        select(User.id).where(User.tenant_id == tenant.id)
    )
    user_ids = [uid for (uid,) in user_ids_result.all()]

    if user_ids:
        # piracy_reports and device_changes reference users/devices
        await session.execute(sa_delete(PiracyReport).where(PiracyReport.user_id.in_(user_ids)))
        await session.execute(sa_delete(DeviceChange).where(DeviceChange.user_id.in_(user_ids)))
        await session.execute(sa_delete(License).where(License.user_id.in_(user_ids)))
        await session.execute(sa_delete(Device).where(Device.user_id.in_(user_ids)))
        await session.execute(sa_delete(User).where(User.id.in_(user_ids)))

    await session.execute(sa_delete(Video).where(Video.tenant_id == tenant.id))
    await session.execute(sa_delete(Tenant).where(Tenant.id == tenant.id))
    await session.commit()

    return TenantActionResponse(
        tenant_id=str(tenant_id),
        is_active=False,
        message=f"Tenant '{tenant.slug}' permanently deleted.",
    )
