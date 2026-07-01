"""Master (platform-admin) API endpoints.

These endpoints are used by the master dashboard only. Authentication uses
a distinct JWT `type` claim ("master_access") — tenant-user tokens are
rejected by `get_current_master_admin`.
"""

import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from jose import JWTError
import sqlalchemy as sa
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
from app.models.course import Course
from app.models.device import Device
from app.models.encryptor_device import EncryptorDevice
from app.models.enrollment import Enrollment
from app.models.platform_admin import PlatformAdmin
from app.models.seat_upgrade_request import (
    SEAT_REQUEST_FULFILLED,
    SEAT_REQUEST_PENDING,
    SEAT_REQUEST_REJECTED,
    SeatUpgradeRequest,
)
from app.models.tenant import Tenant
from app.models.user import User
from app.models.video import Video
from app.schemas.master import (
    BulkTenantActionRequest,
    BulkTenantActionResponse,
    HandleUpgradeRequest,
    ImpersonationTokenResponse,
    MasterLoginRequest,
    MasterRefreshRequest,
    MasterTokenResponse,
    PlatformStatsOut,
    SeatUpgradeRequestOut,
    SuspendTenantRequest,
    TenantActionResponse,
    TenantCreateRequest,
    TenantCreateResponse,
    TenantLimitsUpdate,
    TenantListResponse,
    TotpRecoveryCodesResponse,
    TenantSummary,
    TotpConfirmRequest,
    TotpDisableRequest,
    TotpEnableResponse,
)
from app.services import totp_service
from app.services.audit_service import write_audit

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
    """Log in as a platform admin. Requires TOTP code if 2FA is enabled."""
    result = await session.execute(
        select(PlatformAdmin).where(PlatformAdmin.email == body.email)
    )
    admin = result.scalar_one_or_none()
    if admin is None or not admin.is_active or not verify_password(body.password, admin.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if admin.totp_enabled:
        if not body.totp_code:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="TOTP code required for this account",
                headers={"X-Auth-Reason": "totp_required"},
            )
        # Accept either a 6-digit TOTP code OR a single-use recovery code.
        # Recovery codes are formatted "xxxxx-xxxxx" (10 hex + a dash) which
        # is structurally different from a 6-digit TOTP, so the right path is
        # selected by length without a separate field.
        ok = False
        if len(body.totp_code) <= 8:
            ok = totp_service.verify(admin.totp_secret or "", body.totp_code)
        else:
            # Recovery code path: bcrypt-compare against each stored hash;
            # on match, atomically remove that hash from the JSONB array.
            from app.core.security import verify_password as _vp
            codes = list(admin.totp_recovery_codes_hashed or [])
            matched_idx = None
            for i, h in enumerate(codes):
                if _vp(body.totp_code, h):
                    matched_idx = i
                    break
            if matched_idx is not None:
                codes.pop(matched_idx)
                admin.totp_recovery_codes_hashed = codes
                await session.commit()
                ok = True
        if not ok:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid TOTP code",
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
    """List every tenant with aggregate stats + v1.5 operational metadata."""
    from datetime import timedelta
    cutoff_30d = datetime.now(timezone.utc) - timedelta(days=30)

    tenants_result = await session.execute(
        select(Tenant).order_by(Tenant.created_at.desc())
    )
    tenants = tenants_result.scalars().all()

    summaries: list[TenantSummary] = []
    for tenant in tenants:
        student_count = await session.scalar(
            select(func.count())
            .select_from(User)
            .where(User.tenant_id == tenant.id, User.role == "student")
        ) or 0
        admin_count = await session.scalar(
            select(func.count())
            .select_from(User)
            .where(User.tenant_id == tenant.id, User.role == "admin")
        ) or 0
        video_count = await session.scalar(
            select(func.count())
            .select_from(Video)
            .where(Video.tenant_id == tenant.id)
        ) or 0
        active_device_count = await session.scalar(
            select(func.count())
            .select_from(Device)
            .join(User, User.id == Device.user_id)
            .where(User.tenant_id == tenant.id, Device.is_active == True)  # noqa: E712
        ) or 0
        encryptor_seats_used = await session.scalar(
            select(func.count())
            .select_from(EncryptorDevice)
            .where(
                EncryptorDevice.tenant_id == tenant.id,
                EncryptorDevice.is_active == True,  # noqa: E712
            )
        ) or 0
        course_count = await session.scalar(
            select(func.count())
            .select_from(Course)
            .where(Course.tenant_id == tenant.id)
        ) or 0

        # ── v1.5 metrics ──
        # Last admin login: max(users.last_login_at) for admins of this tenant.
        last_admin_login_at = await session.scalar(
            select(func.max(User.last_login_at))
            .where(User.tenant_id == tenant.id, User.role == "admin")
        )
        # Total storage: sum every value in Video.file_sizes (JSONB).
        # Postgres jsonb_each_text → cast to bigint → sum.
        # Wrap in coalesce so empty results give 0 rather than NULL.
        total_storage_q = sa.text(
            "SELECT COALESCE(SUM((value)::bigint), 0) "
            "FROM videos, jsonb_each_text(videos.file_sizes) "
            "WHERE videos.tenant_id = :tid"
        )
        total_storage_bytes = (
            await session.execute(total_storage_q, {"tid": tenant.id})
        ).scalar() or 0
        # 30-day deltas from existing created_at columns — no snapshot table needed.
        new_students_30d = await session.scalar(
            select(func.count())
            .select_from(User)
            .where(
                User.tenant_id == tenant.id,
                User.role == "student",
                User.created_at >= cutoff_30d,
            )
        ) or 0
        new_videos_30d = await session.scalar(
            select(func.count())
            .select_from(Video)
            .where(Video.tenant_id == tenant.id, Video.created_at >= cutoff_30d)
        ) or 0
        new_courses_30d = await session.scalar(
            select(func.count())
            .select_from(Course)
            .where(Course.tenant_id == tenant.id, Course.created_at >= cutoff_30d)
        ) or 0

        summaries.append(TenantSummary(
            id=str(tenant.id),
            name=tenant.name,
            slug=tenant.slug,
            is_active=tenant.is_active,
            suspended_at=tenant.suspended_at.isoformat() if tenant.suspended_at else None,
            suspension_reason=tenant.suspension_reason,
            created_at=tenant.created_at.isoformat(),
            student_count=student_count,
            admin_count=admin_count,
            video_count=video_count,
            course_count=course_count,
            active_device_count=active_device_count,
            encryptor_seats_used=encryptor_seats_used,
            encryptor_seats_total=tenant.max_encryptor_devices,
            students_total=tenant.max_students,
            videos_total=tenant.max_videos,
            courses_total=tenant.max_courses,
            tier=tenant.tier,
            monthly_price_cents=tenant.monthly_price_cents,
            last_admin_login_at=(
                last_admin_login_at.isoformat() if last_admin_login_at else None
            ),
            total_storage_bytes=int(total_storage_bytes),
            new_students_30d=new_students_30d,
            new_videos_30d=new_videos_30d,
            new_courses_30d=new_courses_30d,
        ))

    return TenantListResponse(tenants=summaries)


@router.post("/tenants", response_model=TenantCreateResponse, status_code=201)
async def create_tenant(
    body: TenantCreateRequest,
    request: Request,
    admin: PlatformAdmin = Depends(get_current_master_admin),
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

    # AP-003: tenant creation was not being audit-logged.
    await write_audit(
        session, tenant_id=tenant.id, actor_type="platform_admin",
        actor_id=str(admin.id), actor_email=admin.email,
        action="tenant.create", target_type="tenant", target_id=str(tenant.id),
        details={"name": tenant.name, "slug": tenant.slug, "admin_email": admin_user.email},
        request=request,
    )
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
    request: Request,
    body: SuspendTenantRequest | None = None,
    admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Suspend a tenant with an optional reason shown to the tenant admin
    on their next login attempt ("Suspended — payment overdue, contact …").

    Body is optional for backwards compat; reason defaults to empty.

    Effects:
      - Tenant admins and students are blocked from all API calls immediately
      - Player `/api/videos/key` calls from currently-online students start failing
      - Students already in offline mode can keep playing cached videos until
        their 20-day grace period expires, by design.
      - All outstanding refresh tokens for the tenant's users are revoked.
    """
    result = await session.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = result.scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    if not tenant.is_active:
        # Update reason even if already suspended.
        if body and body.reason:
            tenant.suspension_reason = body.reason
            await session.commit()
        return TenantActionResponse(
            tenant_id=str(tenant.id),
            is_active=False,
            message="Tenant was already suspended",
        )

    tenant.is_active = False
    tenant.suspended_at = datetime.now(timezone.utc)
    tenant.suspension_reason = (body.reason if body else "") or None
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

    # AP-003: tenant suspension was not being audit-logged.
    await write_audit(
        session, tenant_id=tenant.id, actor_type="platform_admin",
        actor_id=str(admin.id), actor_email=admin.email,
        action="tenant.suspend", target_type="tenant", target_id=str(tenant.id),
        details={"reason": tenant.suspension_reason, "sessions_revoked": revoked},
        request=request,
    )
    await session.commit()

    return TenantActionResponse(
        tenant_id=str(tenant.id),
        is_active=False,
        message=f"Tenant suspended. {revoked} active session(s) revoked.",
    )


@router.patch("/tenants/{tenant_id}/reactivate", response_model=TenantActionResponse)
async def reactivate_tenant(
    tenant_id: uuid.UUID,
    request: Request,
    admin: PlatformAdmin = Depends(get_current_master_admin),
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

    # AP-003: tenant reactivation was not being audit-logged.
    await write_audit(
        session, tenant_id=tenant.id, actor_type="platform_admin",
        actor_id=str(admin.id), actor_email=admin.email,
        action="tenant.reactivate", target_type="tenant", target_id=str(tenant.id),
        request=request,
    )
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
    request: Request,
    admin: PlatformAdmin = Depends(get_current_master_admin),
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
    # FK-safe order: piracy_reports/device_changes/enrollments/encryptor_devices
    # → devices → course_videos → courses → users → videos → tenant.
    from sqlalchemy import delete as sa_delete
    from app.models.course import Course, CourseVideo
    from app.models.device import Device, DeviceChange
    from app.models.encryptor_device import EncryptorDevice
    from app.models.enrollment import Enrollment
    from app.models.piracy_report import PiracyReport
    from app.models.watch_event import WatchEvent

    # watch_events has no ON DELETE CASCADE on tenant/user/video, so a tenant
    # with any watch history would 500 on a FK violation — purge it first.
    # (watch_aggregates DO cascade on user/video delete, so they need no purge.)
    await session.execute(sa_delete(WatchEvent).where(WatchEvent.tenant_id == tenant.id))

    # Collect user IDs for this tenant
    user_ids_result = await session.execute(
        select(User.id).where(User.tenant_id == tenant.id)
    )
    user_ids = [uid for (uid,) in user_ids_result.all()]

    if user_ids:
        await session.execute(sa_delete(PiracyReport).where(PiracyReport.user_id.in_(user_ids)))
        await session.execute(sa_delete(DeviceChange).where(DeviceChange.user_id.in_(user_ids)))
        await session.execute(sa_delete(Enrollment).where(Enrollment.user_id.in_(user_ids)))
        await session.execute(sa_delete(Device).where(Device.user_id.in_(user_ids)))

    # Encryptor devices are tenant-scoped, not user-scoped.
    await session.execute(sa_delete(EncryptorDevice).where(EncryptorDevice.tenant_id == tenant.id))

    # Courses + their video junctions (CourseVideo cascades on Course delete via FK).
    course_ids_result = await session.execute(
        select(Course.id).where(Course.tenant_id == tenant.id)
    )
    course_ids = [cid for (cid,) in course_ids_result.all()]
    if course_ids:
        await session.execute(sa_delete(CourseVideo).where(CourseVideo.course_id.in_(course_ids)))
        await session.execute(sa_delete(Course).where(Course.id.in_(course_ids)))

    if user_ids:
        await session.execute(sa_delete(User).where(User.id.in_(user_ids)))

    await session.execute(sa_delete(Video).where(Video.tenant_id == tenant.id))
    await session.execute(sa_delete(Tenant).where(Tenant.id == tenant.id))
    await session.commit()

    # AP-003: tenant deletion (irreversible cascade) was not being audit-logged.
    # tenant_id is None because the row no longer exists; the deleted tenant is
    # recorded via target_id + details so the trail survives the cascade.
    await write_audit(
        session, tenant_id=None, actor_type="platform_admin",
        actor_id=str(admin.id), actor_email=admin.email,
        action="tenant.delete", target_type="tenant", target_id=str(tenant_id),
        details={"slug": confirm_slug, "name": tenant.name}, request=request,
    )
    await session.commit()

    return TenantActionResponse(
        tenant_id=str(tenant_id),
        is_active=False,
        message=f"Tenant '{tenant.slug}' permanently deleted.",
    )


# ═══════════════════════════════════════════════════════════════════════════
# v1: tenant limits, seat upgrade queue, platform stats, master 2FA
# ═══════════════════════════════════════════════════════════════════════════


@router.patch("/tenants/{tenant_id}/limits", response_model=TenantActionResponse)
async def update_tenant_limits(
    tenant_id: uuid.UUID,
    body: TenantLimitsUpdate,
    request: Request,
    admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Adjust a tenant's resource caps. Each field is optional — only the
    fields actually present in the request body are mutated. Used by both
    the seat-upgrade flow and the new student/video/course quota editor."""
    tenant = (await session.execute(
        select(Tenant).where(Tenant.id == tenant_id)
    )).scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    changes: dict[str, tuple[int, int]] = {}
    if body.max_encryptor_devices is not None:
        changes["max_encryptor_devices"] = (
            tenant.max_encryptor_devices, body.max_encryptor_devices,
        )
        tenant.max_encryptor_devices = body.max_encryptor_devices
    if body.max_students is not None:
        changes["max_students"] = (tenant.max_students, body.max_students)
        tenant.max_students = body.max_students
    if body.max_videos is not None:
        changes["max_videos"] = (tenant.max_videos, body.max_videos)
        tenant.max_videos = body.max_videos
    if body.max_courses is not None:
        changes["max_courses"] = (tenant.max_courses, body.max_courses)
        tenant.max_courses = body.max_courses

    if not changes:
        raise HTTPException(
            status_code=400,
            detail="At least one of max_encryptor_devices, max_students, "
                   "max_videos, max_courses must be set.",
        )

    await session.commit()

    await write_audit(
        session, tenant_id=tenant.id, actor_type="platform_admin",
        actor_id=str(admin.id), actor_email=admin.email,
        action="tenant.limits_change",
        target_type="tenant", target_id=str(tenant.id),
        details={k: {"old": old, "new": new} for k, (old, new) in changes.items()},
        request=request,
    )
    await session.commit()

    msg = ", ".join(f"{k}: {old}→{new}" for k, (old, new) in changes.items())
    return TenantActionResponse(
        tenant_id=str(tenant.id),
        is_active=tenant.is_active,
        message=msg,
    )


# ─── Master-scoped encryptor device management ──────────────────────────────
#
# The tenant-admin app intentionally has no deregister button — the policy
# decision is "platform owner controls who can hold the master key". Master
# admin uses these endpoints to list and revoke any tenant's encryptor seats.


@router.get("/tenants/{tenant_id}/encryptors")
async def master_list_encryptors(
    tenant_id: uuid.UUID,
    _admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """List a specific tenant's encryptor devices."""
    tenant = (await session.execute(
        select(Tenant).where(Tenant.id == tenant_id)
    )).scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    devices = (await session.execute(
        select(EncryptorDevice)
        .where(EncryptorDevice.tenant_id == tenant_id)
        .order_by(EncryptorDevice.registered_at.desc())
    )).scalars().all()

    seats_used = sum(1 for d in devices if d.is_active)
    return {
        "tenant_id": str(tenant.id),
        "tenant_name": tenant.name,
        "seats_used": seats_used,
        "seats_total": tenant.max_encryptor_devices,
        "devices": [
            {
                "id": str(d.id),
                "fingerprint": (d.fingerprint or "")[:12] + "..."
                if len(d.fingerprint or "") > 12 else (d.fingerprint or ""),
                "hostname": d.hostname,
                "os_version": d.os_version,
                "is_active": d.is_active,
                "registered_at": d.registered_at.isoformat(),
                "last_seen_at": d.last_seen_at.isoformat(),
                "last_master_key_fetch_at": d.last_master_key_fetch_at.isoformat(),
            }
            for d in devices
        ],
    }


@router.delete("/tenants/{tenant_id}/encryptors/{device_id}", response_model=TenantActionResponse)
async def master_deregister_encryptor(
    tenant_id: uuid.UUID,
    device_id: uuid.UUID,
    request: Request,
    admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Master deregisters one of a tenant's encryptor devices. Frees its seat
    immediately. The next time that desktop encryptor app launches, it'll
    fail to fetch the master key and prompt the admin to re-register."""
    device = (await session.execute(
        select(EncryptorDevice).where(
            EncryptorDevice.id == device_id,
            EncryptorDevice.tenant_id == tenant_id,
        )
    )).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Encryptor device not found")

    was_active = device.is_active
    device.is_active = False
    await session.commit()

    await write_audit(
        session, tenant_id=tenant_id, actor_type="platform_admin",
        actor_id=str(admin.id), actor_email=admin.email,
        action="encryptor.master_deregister",
        target_type="encryptor_device", target_id=str(device.id),
        details={"hostname": device.hostname, "was_active": was_active},
        request=request,
    )
    await session.commit()

    return TenantActionResponse(
        tenant_id=str(tenant_id),
        is_active=False,
        message=f"Encryptor device '{device.hostname or device.id}' deregistered.",
    )


@router.get("/upgrade-requests", response_model=list[SeatUpgradeRequestOut])
async def list_upgrade_requests(
    status_filter: str = "pending",
    _admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """List seat-upgrade requests, defaulting to pending. Pass status='all' for everything."""
    q = select(SeatUpgradeRequest)
    if status_filter != "all":
        q = q.where(SeatUpgradeRequest.status == status_filter)
    q = q.order_by(SeatUpgradeRequest.requested_at.desc())
    rows = (await session.execute(q)).scalars().all()

    out: list[SeatUpgradeRequestOut] = []
    for r in rows:
        tenant = (await session.execute(
            select(Tenant).where(Tenant.id == r.tenant_id)
        )).scalar_one_or_none()
        if tenant is None:
            continue
        requester_email = None
        if r.requested_by_user_id:
            u = (await session.execute(
                select(User).where(User.id == r.requested_by_user_id)
            )).scalar_one_or_none()
            requester_email = u.email if u else None
        out.append(SeatUpgradeRequestOut(
            id=str(r.id),
            tenant_id=str(r.tenant_id),
            tenant_name=tenant.name,
            tenant_slug=tenant.slug,
            requested_by_email=requester_email,
            requested_seats=r.requested_seats,
            current_seats=tenant.max_encryptor_devices,
            status=r.status,
            notes=r.notes,
            requested_at=r.requested_at.isoformat(),
            handled_at=r.handled_at.isoformat() if r.handled_at else None,
            handled_notes=r.handled_notes,
        ))
    return out


@router.post("/upgrade-requests/{request_id}/fulfill", response_model=SeatUpgradeRequestOut)
async def fulfill_upgrade_request(
    request_id: uuid.UUID,
    body: HandleUpgradeRequest,
    request: Request,
    admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Mark a request fulfilled. Optionally bump the tenant's seat cap in
    the same call. Idempotent: re-fulfilling a fulfilled request just
    updates handled_notes."""
    req = (await session.execute(
        select(SeatUpgradeRequest).where(SeatUpgradeRequest.id == request_id)
    )).scalar_one_or_none()
    if req is None:
        raise HTTPException(status_code=404, detail="Upgrade request not found")

    tenant = (await session.execute(
        select(Tenant).where(Tenant.id == req.tenant_id)
    )).scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    if body.new_max_encryptor_devices is not None:
        tenant.max_encryptor_devices = max(1, min(body.new_max_encryptor_devices, 100))

    req.status = SEAT_REQUEST_FULFILLED
    req.handled_at = datetime.now(timezone.utc)
    req.handled_by_admin_id = admin.id
    req.handled_notes = body.handled_notes
    await session.commit()
    await session.refresh(req)
    await session.refresh(tenant)

    await write_audit(
        session, tenant_id=tenant.id, actor_type="platform_admin",
        actor_id=str(admin.id), actor_email=admin.email,
        action="seat_upgrade_request.fulfill",
        target_type="seat_upgrade_request", target_id=str(req.id),
        details={
            "tenant_id": str(tenant.id),
            "new_max_encryptor_devices": tenant.max_encryptor_devices,
            "handled_notes": body.handled_notes,
        },
        request=request,
    )
    await session.commit()

    requester_email = None
    if req.requested_by_user_id:
        u = (await session.execute(
            select(User).where(User.id == req.requested_by_user_id)
        )).scalar_one_or_none()
        requester_email = u.email if u else None

    return SeatUpgradeRequestOut(
        id=str(req.id),
        tenant_id=str(req.tenant_id),
        tenant_name=tenant.name,
        tenant_slug=tenant.slug,
        requested_by_email=requester_email,
        requested_seats=req.requested_seats,
        current_seats=tenant.max_encryptor_devices,
        status=req.status,
        notes=req.notes,
        requested_at=req.requested_at.isoformat(),
        handled_at=req.handled_at.isoformat() if req.handled_at else None,
        handled_notes=req.handled_notes,
    )


@router.post("/upgrade-requests/{request_id}/reject", response_model=SeatUpgradeRequestOut)
async def reject_upgrade_request(
    request_id: uuid.UUID,
    body: HandleUpgradeRequest,
    request: Request,
    admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    req = (await session.execute(
        select(SeatUpgradeRequest).where(SeatUpgradeRequest.id == request_id)
    )).scalar_one_or_none()
    if req is None:
        raise HTTPException(status_code=404, detail="Upgrade request not found")

    tenant = (await session.execute(
        select(Tenant).where(Tenant.id == req.tenant_id)
    )).scalar_one()

    req.status = SEAT_REQUEST_REJECTED
    req.handled_at = datetime.now(timezone.utc)
    req.handled_by_admin_id = admin.id
    req.handled_notes = body.handled_notes
    await session.commit()
    await session.refresh(req)

    await write_audit(
        session, tenant_id=tenant.id, actor_type="platform_admin",
        actor_id=str(admin.id), actor_email=admin.email,
        action="seat_upgrade_request.reject",
        target_type="seat_upgrade_request", target_id=str(req.id),
        details={"handled_notes": body.handled_notes},
        request=request,
    )
    await session.commit()

    return SeatUpgradeRequestOut(
        id=str(req.id),
        tenant_id=str(req.tenant_id),
        tenant_name=tenant.name,
        tenant_slug=tenant.slug,
        requested_by_email=None,
        requested_seats=req.requested_seats,
        current_seats=tenant.max_encryptor_devices,
        status=req.status,
        notes=req.notes,
        requested_at=req.requested_at.isoformat(),
        handled_at=req.handled_at.isoformat() if req.handled_at else None,
        handled_notes=req.handled_notes,
    )


@router.get("/stats", response_model=PlatformStatsOut)
async def platform_stats(
    _admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Single-shot platform-wide rollup for the master dashboard tile."""
    total_tenants = await session.scalar(select(func.count()).select_from(Tenant)) or 0
    active_tenants = await session.scalar(
        select(func.count()).select_from(Tenant).where(Tenant.is_active.is_(True))
    ) or 0
    total_users = await session.scalar(select(func.count()).select_from(User)) or 0
    total_admins = await session.scalar(
        select(func.count()).select_from(User).where(User.role == "admin")
    ) or 0
    total_students = await session.scalar(
        select(func.count()).select_from(User).where(User.role == "student")
    ) or 0
    total_videos = await session.scalar(select(func.count()).select_from(Video)) or 0
    total_courses = await session.scalar(select(func.count()).select_from(Course)) or 0
    now = datetime.now(timezone.utc)
    total_active_enrollments = await session.scalar(
        select(func.count())
        .select_from(Enrollment)
        .where(
            Enrollment.is_active.is_(True),
            (Enrollment.expires_at.is_(None)) | (Enrollment.expires_at > now),
        )
    ) or 0
    total_encryptor_devices = await session.scalar(
        select(func.count())
        .select_from(EncryptorDevice)
        .where(EncryptorDevice.is_active.is_(True))
    ) or 0
    pending_seat_upgrades = await session.scalar(
        select(func.count())
        .select_from(SeatUpgradeRequest)
        .where(SeatUpgradeRequest.status == SEAT_REQUEST_PENDING)
    ) or 0

    return PlatformStatsOut(
        total_tenants=int(total_tenants),
        active_tenants=int(active_tenants),
        suspended_tenants=int(total_tenants - active_tenants),
        total_users=int(total_users),
        total_admins=int(total_admins),
        total_students=int(total_students),
        total_videos=int(total_videos),
        total_courses=int(total_courses),
        total_active_enrollments=int(total_active_enrollments),
        total_encryptor_devices=int(total_encryptor_devices),
        pending_seat_upgrades=int(pending_seat_upgrades),
    )


# ─── Master 2FA (TOTP) ──────────────────────────────────────────────────────

@router.post("/me/totp/enable", response_model=TotpEnableResponse)
async def totp_enable(
    request: Request,
    admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Generate a fresh TOTP secret and store it (but DON'T enable 2FA yet —
    that happens on /confirm). The provisioning_uri is what the dashboard
    renders as a QR code; the secret is for manual entry fallback.

    Returning a fresh secret each call is intentional: it overwrites any
    previously-generated-but-unconfirmed secret. Once 2FA is confirmed, this
    endpoint refuses (409) until the admin disables first.
    """
    if admin.totp_enabled:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="2FA is already enabled. Disable it first to re-enroll.",
        )

    secret = totp_service.generate_secret()
    admin.totp_secret = secret
    admin.totp_enabled = False
    await session.commit()

    uri = totp_service.provisioning_uri(admin.email, secret)

    await write_audit(
        session, tenant_id=None, actor_type="platform_admin",
        actor_id=str(admin.id), actor_email=admin.email,
        action="master.totp_enable_start", target_type="platform_admin",
        target_id=str(admin.id), request=request,
    )
    await session.commit()

    return TotpEnableResponse(secret=secret, provisioning_uri=uri)


@router.post("/me/totp/confirm")
async def totp_confirm(
    body: TotpConfirmRequest,
    request: Request,
    admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Confirm 2FA setup by entering a code from the authenticator app.
    Only after this does totp_enabled flip to True; future logins require it."""
    if not admin.totp_secret:
        raise HTTPException(status_code=400, detail="Run /me/totp/enable first")
    if not totp_service.verify(admin.totp_secret, body.code):
        raise HTTPException(status_code=401, detail="Invalid TOTP code")

    admin.totp_enabled = True
    await session.commit()

    await write_audit(
        session, tenant_id=None, actor_type="platform_admin",
        actor_id=str(admin.id), actor_email=admin.email,
        action="master.totp_enable_confirm", target_type="platform_admin",
        target_id=str(admin.id), request=request,
    )
    await session.commit()
    return {"message": "2FA enabled"}


@router.post("/me/totp/disable")
async def totp_disable(
    body: TotpDisableRequest,
    request: Request,
    admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Disable 2FA. Requires re-auth (password) AND a valid current code."""
    if not admin.totp_enabled:
        return {"message": "2FA was not enabled"}
    if not verify_password(body.password, admin.password_hash):
        raise HTTPException(status_code=401, detail="Password re-auth failed")
    if not totp_service.verify(admin.totp_secret or "", body.code):
        raise HTTPException(status_code=401, detail="Invalid TOTP code")

    admin.totp_secret = None
    admin.totp_enabled = False
    await session.commit()

    await write_audit(
        session, tenant_id=None, actor_type="platform_admin",
        actor_id=str(admin.id), actor_email=admin.email,
        action="master.totp_disable", target_type="platform_admin",
        target_id=str(admin.id), request=request,
    )
    await session.commit()
    return {"message": "2FA disabled"}


# ═══════════════════════════════════════════════════════════════════════════
# v1.5: bulk actions, master audit, recovery codes, impersonation
# ═══════════════════════════════════════════════════════════════════════════


@router.post("/tenants/bulk-action", response_model=BulkTenantActionResponse)
async def bulk_tenant_action(
    body: BulkTenantActionRequest,
    request: Request,
    admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Run suspend/reactivate across many tenants in one round-trip. Per-tenant
    failures are reported individually so a bad ID in the middle doesn't abort
    the whole batch."""
    if body.action not in ("suspend", "reactivate"):
        raise HTTPException(status_code=400, detail="action must be suspend or reactivate")

    successes: list[str] = []
    failures: dict[str, str] = {}

    for tid_str in body.tenant_ids:
        try:
            tid = uuid.UUID(tid_str)
        except ValueError:
            failures[tid_str] = "invalid uuid"
            continue
        tenant = (await session.execute(
            select(Tenant).where(Tenant.id == tid)
        )).scalar_one_or_none()
        if tenant is None:
            failures[tid_str] = "not found"
            continue

        if body.action == "suspend":
            if tenant.is_active:
                tenant.is_active = False
                tenant.suspended_at = datetime.now(timezone.utc)
                tenant.suspension_reason = body.reason or None
        else:  # reactivate
            if not tenant.is_active:
                tenant.is_active = True
                tenant.suspended_at = None
                tenant.suspension_reason = None
        successes.append(tid_str)

    await session.commit()

    await write_audit(
        session, tenant_id=None, actor_type="platform_admin",
        actor_id=str(admin.id), actor_email=admin.email,
        action=f"tenant.bulk_{body.action}",
        target_type="bulk", target_id=None,
        details={"count": len(successes), "reason": body.reason, "failed": list(failures.keys())},
        request=request,
    )
    await session.commit()

    return BulkTenantActionResponse(successes=successes, failures=failures)


@router.get("/audit")
async def master_audit(
    action: str | None = None,
    actor_email: str | None = None,
    tenant_id: str | None = None,
    since_days: int = 30,
    limit: int = 200,
    _admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Cross-tenant audit log for the master. Returns rows from `audit_logs`
    with optional filters; tenant_id can be a specific UUID or "system" to
    show only platform-level actions (tenant_id IS NULL)."""
    from app.models.audit_log import AuditLog

    limit = max(1, min(limit, 1000))
    cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)

    q = select(AuditLog).where(AuditLog.occurred_at >= cutoff)
    if action:
        if action.endswith(".*"):
            q = q.where(AuditLog.action.like(action[:-1] + "%"))
        else:
            q = q.where(AuditLog.action == action)
    if actor_email:
        q = q.where(AuditLog.actor_email == actor_email)
    if tenant_id:
        if tenant_id == "system":
            q = q.where(AuditLog.tenant_id.is_(None))
        else:
            try:
                tid = uuid.UUID(tenant_id)
                # Match rows tagged with this tenant_id OR tenant-lifecycle rows
                # whose FK was nulled on delete but still carry
                # target_id=<tenant id>, so a deleted tenant's full history
                # (create/suspend/delete) stays retrievable by this filter.
                q = q.where(
                    sa.or_(
                        AuditLog.tenant_id == tid,
                        sa.and_(
                            AuditLog.target_type == "tenant",
                            AuditLog.target_id == str(tid),
                        ),
                    )
                )
            except ValueError:
                pass

    q = q.order_by(AuditLog.occurred_at.desc()).limit(limit)
    rows = (await session.execute(q)).scalars().all()

    return [
        {
            "id": str(r.id),
            "tenant_id": str(r.tenant_id) if r.tenant_id else None,
            "actor_type": r.actor_type,
            "actor_email": r.actor_email,
            "action": r.action,
            "target_type": r.target_type,
            "target_id": r.target_id,
            "details": r.details or {},
            "ip_address": r.ip_address,
            "occurred_at": r.occurred_at.isoformat(),
        }
        for r in rows
    ]


@router.post("/me/totp/recovery-codes", response_model=TotpRecoveryCodesResponse)
async def regenerate_recovery_codes(
    request: Request,
    admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Generate 10 single-use recovery codes for 2FA. Plaintext codes returned
    EXACTLY ONCE; only bcrypt-style hashes persist. Replaces any prior set."""
    if not admin.totp_enabled:
        raise HTTPException(
            status_code=400,
            detail="Enable 2FA first via /me/totp/enable + /me/totp/confirm",
        )

    plaintexts = [secrets.token_hex(5) + "-" + secrets.token_hex(5) for _ in range(10)]
    # Use the same bcrypt scheme as user passwords for symmetry.
    admin.totp_recovery_codes_hashed = [hash_password(c) for c in plaintexts]
    await session.commit()

    await write_audit(
        session, tenant_id=None, actor_type="platform_admin",
        actor_id=str(admin.id), actor_email=admin.email,
        action="master.totp_recovery_codes_regenerate",
        target_type="platform_admin", target_id=str(admin.id),
        details={"count": 10}, request=request,
    )
    await session.commit()

    return TotpRecoveryCodesResponse(codes=plaintexts)


@router.post("/tenants/{tenant_id}/impersonate", response_model=ImpersonationTokenResponse)
async def impersonate_tenant_admin(
    tenant_id: uuid.UUID,
    request: Request,
    admin: PlatformAdmin = Depends(get_current_master_admin),
    session: AsyncSession = Depends(get_db),
):
    """Generate a 15-minute access token for the tenant's first admin user.
    Lets the master debug a tenant's issue inside the encryptor app without
    knowing their password. The token carries an `impersonator_admin_id`
    claim and is audit-logged."""
    tenant = (await session.execute(
        select(Tenant).where(Tenant.id == tenant_id)
    )).scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    target_admin = (await session.execute(
        select(User)
        .where(User.tenant_id == tenant_id, User.role == "admin", User.is_active.is_(True))
        .order_by(User.created_at.asc())
        .limit(1)
    )).scalar_one_or_none()
    if target_admin is None:
        raise HTTPException(
            status_code=404, detail="Tenant has no active admin users to impersonate"
        )

    now = datetime.now(timezone.utc)
    expire = now + timedelta(minutes=15)
    from jose import jwt as _jwt
    token = _jwt.encode(
        {
            "sub": str(target_admin.id),
            "tenant_id": str(target_admin.tenant_id),
            "role": target_admin.role,
            "iat": now,
            "exp": expire,
            "type": "access",
            "impersonator_admin_id": str(admin.id),
            "impersonator_admin_email": admin.email,
        },
        settings.JWT_SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )

    await write_audit(
        session, tenant_id=tenant_id, actor_type="platform_admin",
        actor_id=str(admin.id), actor_email=admin.email,
        action="master.impersonate_tenant_admin",
        target_type="user", target_id=str(target_admin.id),
        details={"tenant_slug": tenant.slug, "target_email": target_admin.email},
        request=request,
    )
    await session.commit()

    return ImpersonationTokenResponse(
        access_token=token,
        expires_in=900,
        impersonating_user_id=str(target_admin.id),
        impersonating_email=target_admin.email,
        tenant_id=str(tenant_id),
    )
