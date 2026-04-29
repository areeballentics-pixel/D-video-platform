"""Tenant model — each EdTech institute is a tenant."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Integer, LargeBinary, String
from sqlalchemy.dialects.postgresql import JSONB
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
    suspended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # ── v1.5: per-tenant quotas ──
    # Master sets these; tenant admin sees usage + asks for upgrades when
    # they hit the cap. Server enforces on the create-resource endpoints
    # (encryptor seat = HTTP 429; student/course/video = HTTP 402).
    max_encryptor_devices: Mapped[int] = mapped_column(
        Integer, default=1, nullable=False
    )
    max_students: Mapped[int] = mapped_column(Integer, default=50, nullable=False)
    max_videos: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    max_courses: Mapped[int] = mapped_column(Integer, default=20, nullable=False)

    # ── v1.5: tier + price for at-a-glance MRR scanning ──
    tier: Mapped[str] = mapped_column(String(64), default="Free", nullable=False)
    monthly_price_cents: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False
    )

    # ── v1.5: suspension reason shown to tenant admin on login ──
    suspension_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # ── v1: branding ──
    # Institute self-hosts the logo image (Drive / their CDN / wherever) and
    # we just store the URL. Same model as videos: zero storage on our side.
    logo_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    primary_color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    support_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    custom_welcome_message: Mapped[str | None] = mapped_column(String(2000), nullable=True)

    # ── v1: per-tenant feature flags ──
    # Free-form JSON so we don't ship a migration every time a flag is added.
    # Known keys (see tenant dashboard "feature flags" form):
    #   watermarking: bool          — default true
    #   max_devices: int            — default 2; per-student device cap
    #   offline_grace_days: int     — default 20
    #   speed_range: [float, float] — default [0.5, 2.0]; player speed limits
    #   stream_only: bool           — default false; if true, no offline downloads
    #   allow_chapter_skip: bool    — default true
    feature_flags: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

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
