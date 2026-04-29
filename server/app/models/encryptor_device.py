"""EncryptorDevice — registered desktop encryptor app instances per tenant.

The institute admin's encryptor app holds the tenant master key in its OS
keychain. We track each registered device so we can:
  - Enforce the per-tenant `max_encryptor_devices` seat limit
  - Show "registered devices" in the tenant dashboard for revocation
  - Audit master-key fetches per device

Deliberately separate from `devices` (which tracks per-student player
fingerprints) — different lifecycle, different billing model.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class EncryptorDevice(Base):
    __tablename__ = "encryptor_devices"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), index=True
    )

    # SHA-256 hex of stable hardware identifiers, computed by svf-core::device.
    # Widened to 128 to match `Device.fingerprint` (some clients prefix).
    fingerprint: Mapped[str] = mapped_column(String(128))
    hostname: Mapped[str] = mapped_column(String(255), default="")
    os_version: Mapped[str] = mapped_column(String(100), default="")

    # Audit: which admin user clicked "Register" in the encryptor app.
    registered_by_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    registered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    last_master_key_fetch_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    # Re-registering the same device is idempotent (returns existing row).
    __table_args__ = (
        UniqueConstraint("tenant_id", "fingerprint", name="uq_encryptor_tenant_fingerprint"),
    )
