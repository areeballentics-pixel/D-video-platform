"""Tenant-level settings: branding + per-tenant feature flags.

Tenant-admin only. The master dashboard does NOT call these (master's
own settings live elsewhere)."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.database import get_db
from app.models.tenant import Tenant
from app.models.user import User
from app.services.audit_service import write_audit


router = APIRouter()


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")


# ─── Schemas ────────────────────────────────────────────────────────────────

class BrandingOut(BaseModel):
    logo_url: Optional[str]
    primary_color: Optional[str]
    support_email: Optional[str]
    custom_welcome_message: Optional[str]


class BrandingUpdate(BaseModel):
    logo_url: Optional[str] = Field(None, max_length=1000)
    primary_color: Optional[str] = Field(None, max_length=20)
    support_email: Optional[str] = Field(None, max_length=255)
    custom_welcome_message: Optional[str] = Field(None, max_length=2000)


# Known feature-flag keys + their default values (mirrored in player + dashboards).
DEFAULT_FEATURE_FLAGS: dict = {
    "watermarking": True,
    "max_devices": 2,
    "offline_grace_days": 20,
    "speed_range": [0.5, 2.0],
    "stream_only": False,
    "allow_chapter_skip": True,
}


class FeatureFlagsUpdate(BaseModel):
    # Free-form so we can add new flags without ship-blocking schema changes.
    # The PATCH merges this dict into existing feature_flags.
    flags: dict


def _effective_flags(tenant: Tenant) -> dict:
    merged = dict(DEFAULT_FEATURE_FLAGS)
    merged.update(tenant.feature_flags or {})
    return merged


# ─── Endpoints ──────────────────────────────────────────────────────────────

async def _load_tenant(session: AsyncSession, user: User) -> Tenant:
    t = (await session.execute(
        select(Tenant).where(Tenant.id == user.tenant_id)
    )).scalar_one()
    return t


@router.get("/branding", response_model=BrandingOut)
async def get_branding(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    t = await _load_tenant(session, user)
    return BrandingOut(
        logo_url=t.logo_url,
        primary_color=t.primary_color,
        support_email=t.support_email,
        custom_welcome_message=t.custom_welcome_message,
    )


@router.patch("/branding", response_model=BrandingOut)
async def update_branding(
    body: BrandingUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    t = await _load_tenant(session, user)
    if body.logo_url is not None:
        t.logo_url = body.logo_url or None
    if body.primary_color is not None:
        t.primary_color = body.primary_color or None
    if body.support_email is not None:
        t.support_email = body.support_email or None
    if body.custom_welcome_message is not None:
        t.custom_welcome_message = body.custom_welcome_message or None
    await session.commit()
    await session.refresh(t)

    await write_audit(
        session, tenant_id=t.id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="tenant.branding_update", target_type="tenant", target_id=str(t.id),
        details=body.model_dump(exclude_none=True),
        request=request,
    )
    await session.commit()
    return BrandingOut(
        logo_url=t.logo_url,
        primary_color=t.primary_color,
        support_email=t.support_email,
        custom_welcome_message=t.custom_welcome_message,
    )


@router.get("/feature-flags")
async def get_feature_flags(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Returns the merged effective flags (defaults + tenant overrides),
    plus the raw override dict so the dashboard can show 'default' vs 'set'."""
    _require_admin(user)
    t = await _load_tenant(session, user)
    return {
        "effective": _effective_flags(t),
        "overrides": t.feature_flags or {},
        "defaults": DEFAULT_FEATURE_FLAGS,
    }


@router.patch("/feature-flags")
async def update_feature_flags(
    body: FeatureFlagsUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Merge the supplied keys into tenant.feature_flags. Pass `null` to
    a key to remove it (revert to default).

    Validates known keys; unknown keys are accepted (forward-compat) but
    flagged in the response."""
    _require_admin(user)
    t = await _load_tenant(session, user)
    merged = dict(t.feature_flags or {})
    unknown_keys: list[str] = []
    for k, v in body.flags.items():
        if k not in DEFAULT_FEATURE_FLAGS:
            unknown_keys.append(k)
        if v is None:
            merged.pop(k, None)
        else:
            merged[k] = v
    t.feature_flags = merged
    await session.commit()

    await write_audit(
        session, tenant_id=t.id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="tenant.feature_flags_update", target_type="tenant", target_id=str(t.id),
        details={"flags": body.flags, "unknown_keys": unknown_keys},
        request=request,
    )
    await session.commit()
    return {
        "effective": _effective_flags(t),
        "overrides": merged,
        "unknown_keys_accepted": unknown_keys,
    }
