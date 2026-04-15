"""Request/response schemas for the Master (platform-admin) API."""

from pydantic import BaseModel, EmailStr, Field


# ─── Auth ───

class MasterLoginRequest(BaseModel):
    email: EmailStr
    password: str


class MasterTokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    admin_id: str
    email: str


class MasterRefreshRequest(BaseModel):
    refresh_token: str


# ─── Tenants ───

class TenantCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    slug: str = Field(..., min_length=1, max_length=100, pattern=r"^[a-z0-9][a-z0-9-]*$")
    admin_email: EmailStr
    admin_password: str = Field(..., min_length=8, max_length=128)


class TenantCreateResponse(BaseModel):
    """Returned exactly ONCE on tenant creation.

    The master key hex is shown only at creation time so the operator can
    back it up; it cannot be retrieved again from the API.
    """
    tenant_id: str
    tenant_name: str
    tenant_slug: str
    master_key_hex: str
    admin_user_id: str
    admin_email: str


class TenantSummary(BaseModel):
    """Per-row data shown in the master dashboard tenants list."""
    id: str
    name: str
    slug: str
    is_active: bool
    suspended_at: str | None
    created_at: str
    student_count: int
    admin_count: int
    video_count: int
    active_device_count: int


class TenantListResponse(BaseModel):
    tenants: list[TenantSummary]


class TenantActionResponse(BaseModel):
    """Generic ack for suspend / reactivate / delete."""
    tenant_id: str
    is_active: bool
    message: str
