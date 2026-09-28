"""Student-facing API endpoints for batches, courses, and enrolled video playlists."""

import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.database import get_db
from app.models.course import Course, CourseVideo
from app.models.enrollment import Enrollment
from app.models.user import User
from app.models.video import Video


router = APIRouter()


class StudentVideoOut(BaseModel):
    video_id: str
    video_id_hex: str
    title: str
    duration_ms: int
    display_order: int
    is_free_preview: bool
    qualities: list[str] = []


class StudentBatchOut(BaseModel):
    id: str
    name: str
    description: str
    thumbnail_url: Optional[str] = None
    tags: list[str] = []
    display_order: int
    enrolled_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    videos: list[StudentVideoOut] = []


class StudentBatchesResponse(BaseModel):
    batches: list[StudentBatchOut]


@router.get("/batches", response_model=StudentBatchesResponse)
@router.get("/courses", response_model=StudentBatchesResponse)
async def list_student_batches(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Return all courses/batches the authenticated student is actively enrolled in,
    along with their assigned videos in display order.
    """
    now = datetime.now(timezone.utc)

    # 1. Fetch all active, non-expired enrollments for this user
    enrollments_query = (
        select(Course, Enrollment)
        .join(Enrollment, Enrollment.course_id == Course.id)
        .where(
            Enrollment.user_id == user.id,
            Enrollment.is_active.is_(True),
            or_(Enrollment.expires_at.is_(None), Enrollment.expires_at > now),
            Course.is_published.is_(True),
            Course.is_archived.is_(False),
            Course.tenant_id == user.tenant_id,
        )
        .order_by(Course.display_order.asc(), Course.created_at.desc())
    )

    rows = (await session.execute(enrollments_query)).all()

    batches: list[StudentBatchOut] = []

    for course, enrollment in rows:
        # 2. Fetch all videos assigned to this course
        cv_query = (
            select(CourseVideo, Video)
            .join(Video, Video.id == CourseVideo.video_id)
            .where(
                CourseVideo.course_id == course.id,
                Video.tenant_id == user.tenant_id,
            )
            .order_by(CourseVideo.display_order.asc(), CourseVideo.added_at.asc())
        )
        video_rows = (await session.execute(cv_query)).all()

        video_list: list[StudentVideoOut] = []
        for cv, v in video_rows:
            video_list.append(
                StudentVideoOut(
                    video_id=str(v.id),
                    video_id_hex=v.id.hex,
                    title=v.title,
                    duration_ms=v.duration_ms or 0,
                    display_order=cv.display_order,
                    is_free_preview=v.is_free_preview,
                    qualities=v.qualities or [],
                )
            )

        batches.append(
            StudentBatchOut(
                id=str(course.id),
                name=course.name,
                description=course.description or "",
                thumbnail_url=course.thumbnail_url,
                tags=course.tags or [],
                display_order=course.display_order,
                enrolled_at=enrollment.enrolled_at,
                expires_at=enrollment.expires_at,
                videos=video_list,
            )
        )

    return StudentBatchesResponse(batches=batches)
