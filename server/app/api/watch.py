"""Watch-event heartbeat ingest + analytics rollups.

Player flow:
  1. Player sends POST /api/watch-events/heartbeat every 15-30 seconds with
     `(video_id, position_ms, watched_delta_ms)` while playback is active.
  2. Server appends a WatchEvent row AND upserts the (user, video, today)
     row in WatchAggregate so dashboard reads are cheap.
  3. Player can also call GET /api/watch-events/last-position?video_id=...
     to resume from where the student left off across devices.

Admin analytics (tenant-admin only):
  - GET /api/admin/analytics/video/{id}      — view count, avg watch %, drop-off
  - GET /api/admin/analytics/student/{id}    — courses + per-video progress
  - GET /api/admin/analytics/course/{id}     — enrollment + completion rate
"""

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
import sqlalchemy as sa
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.database import get_db
from app.models.course import Course, CourseVideo
from app.models.enrollment import Enrollment
from app.models.user import User
from app.models.video import Video
from app.models.watch_event import WatchAggregate, WatchEvent


# Two routers: one for the player-facing endpoints, one for admin analytics.
router = APIRouter()
admin_router = APIRouter()


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")


# ─── Schemas ────────────────────────────────────────────────────────────────

class HeartbeatIn(BaseModel):
    video_id: str
    position_ms: int
    watched_delta_ms: int = 0
    course_id: Optional[str] = None
    device_id: Optional[str] = None


class LastPositionOut(BaseModel):
    video_id: str
    last_position_ms: int
    max_position_ms: int
    total_watched_ms: int


class VideoAnalyticsOut(BaseModel):
    video_id: str
    title: str
    duration_ms: int
    unique_viewers: int
    total_watch_time_ms: int
    avg_watch_percent: float
    completion_count: int            # viewers who reached ≥90% of duration
    dropoff_buckets: list[int]       # 10 buckets — count of viewers reaching each decile


class StudentAnalyticsOut(BaseModel):
    user_id: str
    email: str
    last_active_at: Optional[str]
    courses_enrolled: int
    videos_watched: int              # videos with any watch_delta > 0
    total_watch_time_ms: int


class CourseAnalyticsOut(BaseModel):
    course_id: str
    name: str
    enrollment_count: int
    video_count: int
    avg_completion_percent: float    # average across enrollees


# ─── Player-facing: heartbeat + last-position ───────────────────────────────

@router.post("/heartbeat")
async def heartbeat(
    body: HeartbeatIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Append a WatchEvent and upsert the daily WatchAggregate row.

    Note: this does NOT validate enrollment — the player has already passed
    license validation when it called /api/videos/key. We just record what
    was watched. If the upstream license check is bypassed somehow, the
    student still gets logged but the dashboard will show their (unauthorized)
    activity, which is useful for the admin to detect.
    """
    try:
        vid = uuid.UUID(body.video_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid video_id")

    course_uuid: Optional[uuid.UUID] = None
    if body.course_id:
        try:
            course_uuid = uuid.UUID(body.course_id)
        except ValueError:
            course_uuid = None

    device_uuid: Optional[uuid.UUID] = None
    if body.device_id:
        try:
            device_uuid = uuid.UUID(body.device_id)
        except ValueError:
            device_uuid = None

    # Verify the video belongs to the user's tenant (sanity, cheap).
    video = (await session.execute(
        select(Video).where(Video.id == vid, Video.tenant_id == user.tenant_id)
    )).scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found in your tenant")

    # Clamp delta to a sane window so a buggy player can't inflate numbers.
    delta = max(0, min(body.watched_delta_ms, 60_000))
    pos = max(0, body.position_ms)

    now = datetime.now(timezone.utc)
    event = WatchEvent(
        tenant_id=user.tenant_id,
        user_id=user.id,
        video_id=vid,
        course_id=course_uuid,
        device_id=device_uuid,
        position_ms=pos,
        watched_delta_ms=delta,
        occurred_at=now,
    )
    session.add(event)

    # Upsert today's aggregate. Postgres ON CONFLICT keeps the dashboard read
    # cheap (single row per user/video/day) without a separate rollup job.
    today = now.date()
    stmt = (
        pg_insert(WatchAggregate.__table__)
        .values(
            user_id=user.id,
            video_id=vid,
            day=today,
            total_watched_ms=delta,
            max_position_ms=pos,
            last_position_ms=pos,
            sessions=1,
            updated_at=now,
        )
        .on_conflict_do_update(
            index_elements=["user_id", "video_id", "day"],
            set_={
                "total_watched_ms": WatchAggregate.__table__.c.total_watched_ms + delta,
                "max_position_ms": func.greatest(
                    WatchAggregate.__table__.c.max_position_ms, pos
                ),
                "last_position_ms": pos,
                "sessions": WatchAggregate.__table__.c.sessions + 1,
                "updated_at": now,
            },
        )
    )
    await session.execute(stmt)
    await session.commit()

    return {"ok": True}


@router.get("/last-position", response_model=LastPositionOut)
async def last_position(
    video_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Return where the user left off in a video (most recent day's last_position).
    Player calls this on load to offer a 'resume' button."""
    try:
        vid = uuid.UUID(video_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid video_id")

    # Most recent day for this user/video.
    row = (await session.execute(
        select(WatchAggregate)
        .where(
            WatchAggregate.user_id == user.id,
            WatchAggregate.video_id == vid,
        )
        .order_by(WatchAggregate.day.desc())
        .limit(1)
    )).scalar_one_or_none()

    if row is None:
        return LastPositionOut(
            video_id=video_id,
            last_position_ms=0,
            max_position_ms=0,
            total_watched_ms=0,
        )

    # Sum total across all days.
    total = await session.scalar(
        select(func.coalesce(func.sum(WatchAggregate.total_watched_ms), 0))
        .where(
            WatchAggregate.user_id == user.id,
            WatchAggregate.video_id == vid,
        )
    ) or 0
    max_pos = await session.scalar(
        select(func.coalesce(func.max(WatchAggregate.max_position_ms), 0))
        .where(
            WatchAggregate.user_id == user.id,
            WatchAggregate.video_id == vid,
        )
    ) or 0

    return LastPositionOut(
        video_id=video_id,
        last_position_ms=row.last_position_ms,
        max_position_ms=int(max_pos),
        total_watched_ms=int(total),
    )


# ─── Admin analytics ────────────────────────────────────────────────────────

@admin_router.get("/video/{video_id}", response_model=VideoAnalyticsOut)
async def video_analytics(
    video_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Per-video stats: unique viewers, total watch time, drop-off across
    10 evenly-spaced positional buckets. Bucket N counts unique users whose
    `max_position_ms` reached at least decile N."""
    _require_admin(user)
    try:
        vid = uuid.UUID(video_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid video_id")

    video = (await session.execute(
        select(Video).where(Video.id == vid, Video.tenant_id == user.tenant_id)
    )).scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")

    duration = max(1, video.duration_ms)

    unique_viewers = await session.scalar(
        select(func.count(func.distinct(WatchAggregate.user_id)))
        .where(WatchAggregate.video_id == vid)
    ) or 0

    total_watch_ms = await session.scalar(
        select(func.coalesce(func.sum(WatchAggregate.total_watched_ms), 0))
        .where(WatchAggregate.video_id == vid)
    ) or 0

    # avg_watch_percent = avg(max_position / duration) across distinct users
    avg_max_pos = await session.scalar(
        select(func.coalesce(func.avg(WatchAggregate.max_position_ms), 0))
        .where(WatchAggregate.video_id == vid)
    ) or 0
    avg_watch_percent = float(avg_max_pos) / duration * 100.0

    completion_count = await session.scalar(
        select(func.count(func.distinct(WatchAggregate.user_id)))
        .where(
            WatchAggregate.video_id == vid,
            WatchAggregate.max_position_ms >= int(duration * 0.9),
        )
    ) or 0

    # Drop-off histogram: for each user, take their max max_position_ms, then
    # bucket into deciles. Reading this in pure SQL is doable but more readable
    # to compute in Python on the small per-video result set.
    per_user_max = (await session.execute(
        select(WatchAggregate.user_id, func.max(WatchAggregate.max_position_ms))
        .where(WatchAggregate.video_id == vid)
        .group_by(WatchAggregate.user_id)
    )).all()

    buckets = [0] * 10
    for (_uid, mp) in per_user_max:
        if mp is None:
            continue
        # Bucket index = how many full deciles they reached.
        reached = min(10, int((mp / duration) * 10) + 1)
        for i in range(reached):
            buckets[i] += 1

    return VideoAnalyticsOut(
        video_id=video_id,
        title=video.title,
        duration_ms=video.duration_ms,
        unique_viewers=int(unique_viewers),
        total_watch_time_ms=int(total_watch_ms),
        avg_watch_percent=round(avg_watch_percent, 2),
        completion_count=int(completion_count),
        dropoff_buckets=buckets,
    )


@admin_router.get("/student/{user_id}", response_model=StudentAnalyticsOut)
async def student_analytics(
    user_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid user_id")
    student = (await session.execute(
        select(User).where(User.id == uid, User.tenant_id == user.tenant_id)
    )).scalar_one_or_none()
    if student is None:
        raise HTTPException(status_code=404, detail="Student not found")

    courses_enrolled = await session.scalar(
        select(func.count())
        .select_from(Enrollment)
        .where(
            Enrollment.user_id == uid, Enrollment.is_active.is_(True)
        )
    ) or 0

    videos_watched = await session.scalar(
        select(func.count(func.distinct(WatchAggregate.video_id)))
        .where(WatchAggregate.user_id == uid)
    ) or 0

    total_watch_ms = await session.scalar(
        select(func.coalesce(func.sum(WatchAggregate.total_watched_ms), 0))
        .where(WatchAggregate.user_id == uid)
    ) or 0

    last_active = await session.scalar(
        select(func.max(WatchAggregate.updated_at))
        .where(WatchAggregate.user_id == uid)
    )

    return StudentAnalyticsOut(
        user_id=user_id,
        email=student.email,
        last_active_at=last_active.isoformat() if last_active else None,
        courses_enrolled=int(courses_enrolled),
        videos_watched=int(videos_watched),
        total_watch_time_ms=int(total_watch_ms),
    )


@admin_router.get("/course/{course_id}", response_model=CourseAnalyticsOut)
async def course_analytics(
    course_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    try:
        cid = uuid.UUID(course_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid course_id")

    course = (await session.execute(
        select(Course).where(Course.id == cid, Course.tenant_id == user.tenant_id)
    )).scalar_one_or_none()
    if course is None:
        raise HTTPException(status_code=404, detail="Course not found")

    enrollment_count = await session.scalar(
        select(func.count())
        .select_from(Enrollment)
        .where(Enrollment.course_id == cid, Enrollment.is_active.is_(True))
    ) or 0

    video_ids = (await session.execute(
        select(CourseVideo.video_id).where(CourseVideo.course_id == cid)
    )).scalars().all()
    video_count = len(video_ids)

    avg_completion = 0.0
    if enrollment_count and video_count:
        # Per enrolled student, count distinct videos in this course they've
        # reached ≥90% of. Average across enrolled students.
        student_ids = (await session.execute(
            select(Enrollment.user_id).where(
                Enrollment.course_id == cid, Enrollment.is_active.is_(True)
            )
        )).scalars().all()

        completion_sum = 0.0
        for sid in student_ids:
            # Count videos in this course that this student reached 90%+ on.
            durations = (await session.execute(
                select(Video.id, Video.duration_ms).where(Video.id.in_(video_ids))
            )).all()
            completed = 0
            for vid, dur in durations:
                if dur <= 0:
                    continue
                max_pos = await session.scalar(
                    select(func.coalesce(func.max(WatchAggregate.max_position_ms), 0))
                    .where(
                        WatchAggregate.user_id == sid,
                        WatchAggregate.video_id == vid,
                    )
                ) or 0
                if max_pos >= int(dur * 0.9):
                    completed += 1
            completion_sum += (completed / video_count) * 100.0
        avg_completion = completion_sum / len(student_ids) if student_ids else 0.0

    return CourseAnalyticsOut(
        course_id=course_id,
        name=course.name,
        enrollment_count=int(enrollment_count),
        video_count=video_count,
        avg_completion_percent=round(avg_completion, 2),
    )


@admin_router.get("/recently-watched")
async def recently_watched(
    limit: int = 10,
    days: int = 7,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Top-N most-watched videos in the last N days, by minutes consumed.
    Drives a "where's student attention going" tile on the encryptor home."""
    _require_admin(user)
    limit = max(1, min(limit, 50))
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    rows = (await session.execute(
        select(
            Video.id,
            Video.title,
            func.coalesce(func.sum(WatchEvent.watched_delta_ms), 0).label("ms"),
            func.count(func.distinct(WatchEvent.user_id)).label("viewers"),
        )
        .select_from(Video)
        .outerjoin(
            WatchEvent,
            sa.and_(WatchEvent.video_id == Video.id, WatchEvent.occurred_at >= cutoff),
        )
        .where(Video.tenant_id == user.tenant_id)
        .group_by(Video.id, Video.title)
        .order_by(sa.desc("ms"), sa.desc("viewers"))
        .limit(limit)
    )).all()

    return [
        {
            "video_id": str(r[0]),
            "title": r[1],
            "watched_minutes": int(r[2]) // 60_000,
            "unique_viewers": int(r[3]),
        }
        for r in rows
    ]
