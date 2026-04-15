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
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PlatformAdmin(Base):
    __tablename__ = "platform_admins"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
