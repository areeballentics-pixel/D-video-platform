"""Video model — metadata for institute-encrypted videos.

In the v1 architecture, the institute's desktop encryptor app produces .svf
files locally and uploads them to their own delivery channel (Google Drive
etc.). The server stores only metadata: per-quality encryption parameters,
download URLs, content hashes, file sizes — everything a player needs to
fetch + verify + decrypt a .svf without the server ever seeing the bytes.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


# Video lifecycle status
VIDEO_STATUS_PENDING_URLS = "pending_urls"  # encrypted, awaiting Drive URLs
VIDEO_STATUS_LIVE = "live"                  # download_urls populated; students can play
VIDEO_STATUS_ARCHIVED = "archived"          # hidden from students; URLs may be revoked


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"), index=True)

    title: Mapped[str] = mapped_column(String(512))
    description: Mapped[str] = mapped_column(String(2000), default="")

    # Quality levels actually encrypted, e.g. ["720p"] or ["480p", "1080p"].
    # In v1 the encryptor produces one quality per upload, but a Video row may
    # accumulate multiple qualities over time as the institute encrypts more
    # files for the same logical video.
    qualities: Mapped[list] = mapped_column(JSONB, default=list)

    # Per-quality encryption parameters, keyed by quality string.
    # Shape: {"720p": {"salt": "<64-hex>", "nonce": "<32-hex>"}, ...}
    # Each .svf file has its own salt + nonce (different from the legacy
    # server-side worker which shared one salt across qualities).
    encryption_params: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    # Per-quality download URLs (institute-hosted), keyed by quality string.
    # Shape: {"720p": "https://drive.google.com/file/d/..."}
    # When all qualities have a URL, status flips from pending_urls → live.
    download_urls: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    # Per-quality SHA-256 of the original (pre-encryption) source, hex-encoded.
    # Player verifies this after download to detect tampering or wrong file.
    # Shape: {"720p": "<64-hex>"}
    content_hashes: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    # Per-quality .svf file size in bytes, for the player's progress UI.
    # Shape: {"720p": 524288000}
    file_sizes: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    status: Mapped[str] = mapped_column(
        String(32), default=VIDEO_STATUS_PENDING_URLS, nullable=False
    )

    duration_ms: Mapped[int] = mapped_column(BigInteger, default=0)

    # ── v1: per-video flags ──
    # Free preview videos are playable without enrollment in any course.
    is_free_preview: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Stream-only mode disallows offline download on student devices.
    is_stream_only: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # ── v1: chapters + transcripts ──
    # Shape: [{"title": "Intro", "start_ms": 0}, {"title": "Theorem", "start_ms": 120000}, ...]
    chapters: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)
    # Institute-hosted transcript (.srt or .vtt) URL. Optional.
    transcript_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    tenant = relationship("Tenant", back_populates="videos")
