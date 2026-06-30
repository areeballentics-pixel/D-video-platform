"""User model — students and tenant admins."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"), index=True)

    email: Mapped[str] = mapped_column(String(255), index=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    license_key: Mapped[str | None] = mapped_column(String(50), unique=True, nullable=True)

    role: Mapped[str] = mapped_column(String(20), default="student")  # "student" or "admin"
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    max_devices: Mapped[int] = mapped_column(Integer, default=2)
    max_device_changes_per_30d: Mapped[int] = mapped_column(Integer, default=2)

    # ── v1: login tracking + lockout ──
    last_login_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    failed_login_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Free-form admin-only notes ("paid late, extend by 1mo"). Never shown to students.
    admin_notes: Mapped[str | None] = mapped_column(String(5000), nullable=True)

    # Bumped to "now" on password reset / forced logout. Access tokens carry an
    # `iat`; get_current_user rejects any token issued before this instant, so a
    # password change immediately ends every existing session (QA SP-001).
    tokens_valid_from: Mapped[datetime | None] = mapped_column(
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

    # Unique email per tenant
    __table_args__ = (UniqueConstraint("tenant_id", "email", name="uq_tenant_email"),)

    # Relationships
    tenant = relationship("Tenant", back_populates="users")
    devices = relationship("Device", back_populates="user", lazy="selectin")
