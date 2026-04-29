"""PlatformAdmin model — operators of the SaaS platform itself.

Platform admins sit ABOVE tenants. They can create, suspend, and delete
tenants, and see platform-wide stats. They intentionally do NOT share
a table with regular tenant Users:
  - They have no tenant_id (they oversee all tenants)
  - A compromised tenant admin must have zero path to master privileges
  - Their JWTs use a distinct `type` claim ("master_access" / "master_refresh")
    that the regular tenant-scoped auth dependency rejects.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PlatformAdmin(Base):
    __tablename__ = "platform_admins"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # ── v1: TOTP-based 2FA ──
    # Base32-encoded TOTP secret (~32 chars). NULL until the admin completes
    # the 2FA setup flow. `totp_enabled` flips to True only after they confirm
    # by entering a valid code from their authenticator app.
    totp_secret: Mapped[str | None] = mapped_column(String(64), nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # ── v1.5: 2FA recovery codes (10 single-use, hashed) ──
    totp_recovery_codes_hashed: Mapped[list] = mapped_column(
        JSONB, default=list, nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
