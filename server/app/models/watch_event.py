"""WatchEvent + WatchAggregate — playback heartbeat ingest + daily rollups.

The player emits a heartbeat every 15-30 seconds during playback with the
current position and how much was actually watched in that interval. This
data drives:
  - "Resume from where you left off" UX (last_position_ms in WatchAggregate)
  - Drop-off graphs (which percentile of the video do students stop at?)
  - Per-student progress per course (% of course videos watched ≥ N%)
  - Course completion rates

Privacy: contains personal viewing data. Disclosed in the tenant's privacy
policy; subject to DPDP Act 2023 (India) for Indian tenants.
"""

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class WatchEvent(Base):
    """Append-only log of player heartbeats. Aggregated daily into WatchAggregate."""
    __tablename__ = "watch_events"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    video_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("videos.id"), index=True)
    # Course context if the player launched playback from a course; NULL if
    # the student opened the .svf via "library" with no course frame.
    course_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("courses.id"), nullable=True
    )
    device_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("devices.id"), nullable=True
    )

    # Current playback position in milliseconds.
    position_ms: Mapped[int] = mapped_column(BigInteger)
    # How much was actually watched in this heartbeat interval (≤ heartbeat
    # interval). Pause/seek-back periods don't count.
    watched_delta_ms: Mapped[int] = mapped_column(Integer, default=0)

    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )


class WatchAggregate(Base):
    """Daily rollup, one row per (user, video, day).

    Computed by a periodic job (or lazily on dashboard read) by summing
    watched_delta_ms and tracking max/last position from WatchEvents.
    """
    __tablename__ = "watch_aggregates"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    video_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("videos.id", ondelete="CASCADE"), primary_key=True
    )
    day: Mapped[date] = mapped_column(Date, primary_key=True)

    total_watched_ms: Mapped[int] = mapped_column(BigInteger, default=0)
    # Furthest position reached on this day (for drop-off graph).
    max_position_ms: Mapped[int] = mapped_column(BigInteger, default=0)
    # Most recent position; player resumes from here. Per-day, but the
    # dashboard typically reads the latest day.
    last_position_ms: Mapped[int] = mapped_column(BigInteger, default=0)
    sessions: Mapped[int] = mapped_column(Integer, default=0)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
