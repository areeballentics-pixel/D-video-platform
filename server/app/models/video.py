"""Video model — metadata for encrypted videos."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, DateTime, ForeignKey, LargeBinary, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"), index=True)

    title: Mapped[str] = mapped_column(String(512))
    description: Mapped[str] = mapped_column(String(2000), default="")

    # Available quality levels, e.g. ["480p", "720p", "1080p"]
    qualities: Mapped[dict] = mapped_column(JSONB, default=list)

    # Encryption parameters (needed to derive the per-video key)
    encryption_salt: Mapped[bytes] = mapped_column(LargeBinary(32))
    encryption_nonce: Mapped[bytes] = mapped_column(LargeBinary(16))

    duration_ms: Mapped[int] = mapped_column(BigInteger, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    # Relationships
    tenant = relationship("Tenant", back_populates="videos")
