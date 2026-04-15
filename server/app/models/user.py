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
    licenses = relationship("License", back_populates="user", lazy="selectin")
