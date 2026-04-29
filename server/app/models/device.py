"""Device model — registered devices per user + change audit log."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)

    # Allow up to 128 chars so prefixed formats like
    # "encryptor-app-<64-hex>" or "dashboard-<uuid>" fit comfortably.
    fingerprint: Mapped[str] = mapped_column(String(128))
    hostname: Mapped[str] = mapped_column(String(255), default="")
    os_version: Mapped[str] = mapped_column(String(100), default="")

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    registered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    # A user can only register a given fingerprint once
    __table_args__ = (UniqueConstraint("user_id", "fingerprint", name="uq_user_fingerprint"),)

    # Relationships
    user = relationship("User", back_populates="devices")


class DeviceChange(Base):
    """Audit log for device registration/deregistration events."""
    __tablename__ = "device_changes"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    old_device_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("devices.id"), nullable=True
    )
    new_device_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("devices.id"), nullable=True
    )
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
