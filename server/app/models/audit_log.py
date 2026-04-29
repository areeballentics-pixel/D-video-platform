"""AuditLog — append-only record of admin actions for compliance + debugging.

Events are emitted by the API layer when sensitive actions occur. Examples:
  - encryptor.register, encryptor.master_key_fetch, encryptor.deregister
  - student.create, student.bulk_import, student.enrollment_grant, student.enrollment_revoke
  - course.create, course.archive, course.delete
  - video.delete, video.update_download_urls
  - tenant.suspend (master), tenant.reactivate (master), tenant.encryptor_seats_change

Tenant admins see their own tenant's logs; platform admins see everything
(tenant_id NULL means cross-tenant master action).
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)

    # Tenant scope. NULL for platform-admin actions that span tenants.
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # Actor type: "tenant_admin" | "platform_admin" | "system" | "encryptor"
    actor_type: Mapped[str] = mapped_column(String(20))
    # Stored as raw UUID-string so it works for both User and PlatformAdmin
    # (different tables) without a polymorphic FK.
    actor_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    actor_email: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Dot-namespaced action key. Examples above.
    action: Mapped[str] = mapped_column(String(100), index=True)

    # Free-form target reference, e.g. ("video", "<uuid>") or ("student", "<uuid>")
    target_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    target_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Context-specific structured details (request body subset, before/after, etc.)
    details: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    # IPv4 or IPv6 string. May be NULL when emitted from an internal worker.
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)

    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
