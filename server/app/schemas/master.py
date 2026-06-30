"""Request/response schemas for the Master (platform-admin) API."""

from pydantic import BaseModel, Field, field_validator

from app.utils.validation import is_valid_email


# ─── Auth ───

class MasterLoginRequest(BaseModel):
    # Plain `str`, not `EmailStr` — pydantic's email-validator rejects
    # `.local`, `.internal`, etc. per RFC 6761, which trips up internal-only
    # email domains. See app/schemas/auth.py for the same rationale.
    email: str
    password: str
    # 6-digit TOTP code from the admin's authenticator app. Required when
    # the admin has totp_enabled=True; ignored otherwise.
    totp_code: str | None = None


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
    name: str = Field(..., min_length=2, max_length=255)  # AP-011: reject 1-char names
    slug: str = Field(..., min_length=1, max_length=100, pattern=r"^[a-z0-9][a-z0-9-]*$")
    admin_email: str
    admin_password: str = Field(..., min_length=8, max_length=128)

    @field_validator("admin_email")
    @classmethod
    def _validate_admin_email(cls, v: str) -> str:
        # AP-001: the field was a bare `str` with no validation, so `abc@g`
        # and `123@q` were accepted. Reject structurally-invalid addresses.
        v = (v or "").strip()
        if not is_valid_email(v):
            raise ValueError("admin_email must be a valid email address")
        return v


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
    suspension_reason: str | None
    created_at: str
    student_count: int
    admin_count: int
    video_count: int
    course_count: int
    active_device_count: int
    encryptor_seats_used: int
    encryptor_seats_total: int
    students_total: int   # max_students cap
    videos_total: int     # max_videos cap
    courses_total: int    # max_courses cap
    # v1.5 — operational visibility
    tier: str
    monthly_price_cents: int
    last_admin_login_at: str | None  # max(users.last_login_at where role=admin)
    total_storage_bytes: int         # sum of all Video.file_sizes JSONB values
    new_students_30d: int
    new_videos_30d: int
    new_courses_30d: int


class TenantListResponse(BaseModel):
    tenants: list[TenantSummary]


class TenantActionResponse(BaseModel):
    """Generic ack for suspend / reactivate / delete."""
    tenant_id: str
    is_active: bool
    message: str


class TenantLimitsUpdate(BaseModel):
    """Master adjusts a tenant's resource caps + tier metadata. All fields
    optional — only the fields actually set in the request body are updated."""
    max_encryptor_devices: int | None = Field(None, ge=1, le=100)
    max_students: int | None = Field(None, ge=0, le=100_000)
    max_videos: int | None = Field(None, ge=0, le=100_000)
    max_courses: int | None = Field(None, ge=0, le=100_000)
    tier: str | None = Field(None, max_length=64)
    monthly_price_cents: int | None = Field(None, ge=0, le=100_000_000)


class SuspendTenantRequest(BaseModel):
    """Suspend with an optional human-readable reason shown to the tenant."""
    reason: str = Field("", max_length=500)


class BulkTenantActionRequest(BaseModel):
    """Run one operation across many tenants in a single round-trip."""
    tenant_ids: list[str]
    action: str  # "suspend" | "reactivate"
    reason: str = Field("", max_length=500)


class BulkTenantActionResponse(BaseModel):
    successes: list[str]
    failures: dict[str, str]  # tenant_id -> error message


class TotpRecoveryCodesResponse(BaseModel):
    """Returned exactly once on /me/totp/recovery-codes. NOT retrievable again."""
    codes: list[str]


class ImpersonationTokenResponse(BaseModel):
    """Short-lived (15-min) JWT for the master to act as a tenant admin."""
    access_token: str
    expires_in: int
    impersonating_user_id: str
    impersonating_email: str
    tenant_id: str


class SeatUpgradeRequestOut(BaseModel):
    id: str
    tenant_id: str
    tenant_name: str
    tenant_slug: str
    requested_by_email: str | None
    requested_seats: int
    current_seats: int
    status: str
    notes: str
    requested_at: str
    handled_at: str | None
    handled_notes: str | None


class HandleUpgradeRequest(BaseModel):
    new_max_encryptor_devices: int | None = None  # if None, keep current cap
    handled_notes: str = ""


class PlatformStatsOut(BaseModel):
    total_tenants: int
    active_tenants: int
    suspended_tenants: int
    total_users: int
    total_admins: int
    total_students: int
    total_videos: int
    total_courses: int
    total_active_enrollments: int
    total_encryptor_devices: int
    pending_seat_upgrades: int


class TotpEnableResponse(BaseModel):
    """Returned to the admin once on /me/totp/enable. The provisioning_uri
    can be rendered as a QR code; the secret can be typed manually."""
    secret: str
    provisioning_uri: str


class TotpConfirmRequest(BaseModel):
    code: str = Field(..., min_length=6, max_length=10)


class TotpDisableRequest(BaseModel):
    password: str
    code: str = Field(..., min_length=6, max_length=10)
