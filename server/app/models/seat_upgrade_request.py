"""SeatUpgradeRequest — tenant admin asks the platform admin for more
encryptor-device seats when they hit their `Tenant.max_encryptor_devices` cap.

Closes the upgrade-billing loop without manual emails: the master dashboard
shows the queue of pending requests and the master admin bumps the cap +
marks the request fulfilled in one flow.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


SEAT_REQUEST_PENDING = "pending"
SEAT_REQUEST_FULFILLED = "fulfilled"
SEAT_REQUEST_REJECTED = "rejected"


class SeatUpgradeRequest(Base):
    __tablename__ = "seat_upgrade_requests"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)

    tenant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), index=True
    )
    requested_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    requested_seats: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(
        String(20), default=SEAT_REQUEST_PENDING, nullable=False, index=True
    )
    notes: Mapped[str] = mapped_column(String(2000), default="", nullable=False)

    requested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    handled_by_admin_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("platform_admins.id", ondelete="SET NULL"), nullable=True
    )
    handled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    handled_notes: Mapped[str | None] = mapped_column(String(2000), nullable=True)
