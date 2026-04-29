"""Course model — institute-defined collection of videos.

Courses replace the v0 wildcard-license model. Students gain access to videos
by being enrolled in a course; per-video access is no longer granted directly.
Free-preview videos (Video.is_free_preview) bypass this check.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Course(Base):
    __tablename__ = "courses"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"), index=True)

    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(String(5000), default="")

    # Institute-hosted thumbnail (Drive / their CDN). Optional.
    thumbnail_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)

    # Optional intro / orientation video, auto-shown when a student first
    # opens the course. References videos.id and is enforced as belonging
    # to the same tenant at the application layer.
    intro_video_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("videos.id"), nullable=True
    )

    # Display ordering of courses on the institute's dashboard / student library.
    display_order: Mapped[int] = mapped_column(Integer, default=0)

    # Lifecycle:
    # is_published=False → admin builds quietly; students don't see the course.
    # is_archived=True   → soft-delete; no new enrollments, students keep access
    #                       but the course is hidden by default in lists.
    is_published: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Free-form tags for institute-side filtering, e.g. ["CA Foundation", "2026 batch"].
    tags: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)

    # Institute-self-hosted resource URLs:
    # [{"label": "Lecture notes (PDF)", "url": "https://drive.google.com/..."}, ...]
    resource_attachments: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class CourseVideo(Base):
    """Many-to-many: which videos belong to which course, in which order.

    The same Video may appear in multiple Courses (e.g., a "fundamentals"
    lecture reused across batches). Order is per-course via display_order.
    """
    __tablename__ = "course_videos"

    course_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("courses.id", ondelete="CASCADE"), primary_key=True
    )
    video_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("videos.id", ondelete="CASCADE"), primary_key=True
    )
    display_order: Mapped[int] = mapped_column(Integer, default=0)
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
