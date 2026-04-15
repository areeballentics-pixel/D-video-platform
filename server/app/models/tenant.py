"""Tenant model — each EdTech company is a tenant."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255))
    slug: Mapped[str] = mapped_column(String(100), unique=True, index=True)

    # Master encryption key, encrypted at rest with SERVER_ENCRYPTION_KEY
    master_key: Mapped[bytes] = mapped_column(LargeBinary)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Timestamp of the most recent suspension (null if the tenant has never
    # been suspended or was since reactivated). Audit trail only — the
    # authoritative "is this tenant allowed to operate?" check is `is_active`.
    suspended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    users = relationship("User", back_populates="tenant", lazy="selectin")
    videos = relationship("Video", back_populates="tenant", lazy="selectin")
