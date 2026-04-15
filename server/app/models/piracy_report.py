"""Piracy report model — logged when the player detects suspicious activity."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PiracyReport(Base):
    __tablename__ = "piracy_reports"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    device_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("devices.id"))

    # e.g. "screen_recorder", "remote_desktop", "debugger", "vm"
    event_type: Mapped[str] = mapped_column(String(50))
    details: Mapped[dict] = mapped_column(JSONB, default=dict)

    reported_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
