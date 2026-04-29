"""Course management — CRUD + video membership + reorder + duplicate.

Tenant-admin only. All courses are scoped to the caller's tenant; no
cross-tenant access is possible.
"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.database import get_db
from app.models.course import Course, CourseVideo
from app.models.enrollment import Enrollment
from app.models.user import User
from app.models.video import Video
from app.services.audit_service import write_audit


router = APIRouter()


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")


# ─── Schemas ────────────────────────────────────────────────────────────────

class ResourceAttachment(BaseModel):
    label: str = Field(..., max_length=200)
    url: str = Field(..., max_length=1000)


class CourseCreate(BaseModel):
    name: str = Field(..., max_length=255)
    description: str = ""
    thumbnail_url: str | None = None
    intro_video_id: str | None = None
    tags: list[str] = []
    resource_attachments: list[ResourceAttachment] = []


class CourseUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    thumbnail_url: str | None = None
    intro_video_id: str | None = None
    tags: list[str] | None = None
    resource_attachments: list[ResourceAttachment] | None = None


class CourseOut(BaseModel):
    id: str
    name: str
    description: str
    thumbnail_url: str | None
    intro_video_id: str | None
    display_order: int
    is_published: bool
    is_archived: bool
    tags: list
    resource_attachments: list
    video_count: int
    enrollment_count: int
    created_at: str
    updated_at: str


class CourseVideoOrder(BaseModel):
    video_id: str
    display_order: int


class CourseVideoOut(BaseModel):
    video_id: str
    title: str
    qualities: list
    duration_ms: int
    status: str
    is_free_preview: bool
    display_order: int


# ─── Helpers ────────────────────────────────────────────────────────────────

async def _course_to_out(session: AsyncSession, c: Course) -> CourseOut:
    video_count = await session.scalar(
        select(func.count()).select_from(CourseVideo).where(CourseVideo.course_id == c.id)
    ) or 0
    enrollment_count = await session.scalar(
        select(func.count()).select_from(Enrollment).where(
            Enrollment.course_id == c.id,
            Enrollment.is_active.is_(True),
        )
    ) or 0
    return CourseOut(
        id=str(c.id),
        name=c.name,
        description=c.description,
        thumbnail_url=c.thumbnail_url,
        intro_video_id=str(c.intro_video_id) if c.intro_video_id else None,
        display_order=c.display_order,
        is_published=c.is_published,
        is_archived=c.is_archived,
        tags=c.tags or [],
        resource_attachments=c.resource_attachments or [],
        video_count=video_count,
        enrollment_count=enrollment_count,
        created_at=c.created_at.isoformat(),
        updated_at=c.updated_at.isoformat(),
    )


async def _load_owned_course(
    session: AsyncSession, course_id: str, tenant_id: uuid.UUID
) -> Course:
    try:
        cid = uuid.UUID(course_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid course_id")
    course = (await session.execute(
        select(Course).where(Course.id == cid, Course.tenant_id == tenant_id)
    )).scalar_one_or_none()
    if course is None:
        raise HTTPException(status_code=404, detail="Course not found")
    return course


async def _verify_video_in_tenant(
    session: AsyncSession, video_id: uuid.UUID, tenant_id: uuid.UUID
) -> Video:
    video = (await session.execute(
        select(Video).where(Video.id == video_id, Video.tenant_id == tenant_id)
    )).scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found in this tenant")
    return video


# ─── Endpoints ──────────────────────────────────────────────────────────────

@router.post("", response_model=CourseOut, status_code=201)
async def create_course(
    body: CourseCreate,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)

    intro_uuid: uuid.UUID | None = None
    if body.intro_video_id:
        try:
            intro_uuid = uuid.UUID(body.intro_video_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid intro_video_id")
        await _verify_video_in_tenant(session, intro_uuid, user.tenant_id)

    # ── Course quota enforcement (402 = "plan-driven, ask master to upgrade") ──
    from app.models.tenant import Tenant as _Tenant
    tenant = (await session.execute(
        select(_Tenant).where(_Tenant.id == user.tenant_id)
    )).scalar_one()
    current_courses = await session.scalar(
        select(func.count())
        .select_from(Course)
        .where(Course.tenant_id == user.tenant_id)
    ) or 0
    if current_courses >= tenant.max_courses:
        raise HTTPException(
            status_code=402,
            detail=(
                f"Course quota reached ({current_courses}/{tenant.max_courses}). "
                f"Contact your platform admin to raise the limit."
            ),
        )

    # Highest display_order + 1, so newest course goes to the end by default.
    max_order = await session.scalar(
        select(func.coalesce(func.max(Course.display_order), -1))
        .where(Course.tenant_id == user.tenant_id)
    )

    course = Course(
        tenant_id=user.tenant_id,
        name=body.name,
        description=body.description,
        thumbnail_url=body.thumbnail_url,
        intro_video_id=intro_uuid,
        display_order=int(max_order) + 1,
        tags=body.tags,
        resource_attachments=[a.model_dump() for a in body.resource_attachments],
    )
    session.add(course)
    await session.commit()
    await session.refresh(course)

    await write_audit(
        session,
        tenant_id=user.tenant_id,
        actor_type="tenant_admin",
        actor_id=str(user.id),
        actor_email=user.email,
        action="course.create",
        target_type="course",
        target_id=str(course.id),
        details={"name": course.name},
        request=request,
    )
    await session.commit()

    return await _course_to_out(session, course)


@router.get("", response_model=list[CourseOut])
async def list_courses(
    include_archived: bool = False,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    q = select(Course).where(Course.tenant_id == user.tenant_id)
    if not include_archived:
        q = q.where(Course.is_archived.is_(False))
    q = q.order_by(Course.display_order.asc(), Course.created_at.desc())

    rows = (await session.execute(q)).scalars().all()
    return [await _course_to_out(session, c) for c in rows]


@router.get("/{course_id}", response_model=CourseOut)
async def get_course(
    course_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    course = await _load_owned_course(session, course_id, user.tenant_id)
    return await _course_to_out(session, course)


@router.patch("/{course_id}", response_model=CourseOut)
async def update_course(
    course_id: str,
    body: CourseUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    course = await _load_owned_course(session, course_id, user.tenant_id)

    if body.name is not None:
        course.name = body.name
    if body.description is not None:
        course.description = body.description
    if body.thumbnail_url is not None:
        course.thumbnail_url = body.thumbnail_url
    if body.intro_video_id is not None:
        if body.intro_video_id == "":
            course.intro_video_id = None
        else:
            try:
                vid = uuid.UUID(body.intro_video_id)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid intro_video_id")
            await _verify_video_in_tenant(session, vid, user.tenant_id)
            course.intro_video_id = vid
    if body.tags is not None:
        course.tags = body.tags
    if body.resource_attachments is not None:
        course.resource_attachments = [a.model_dump() for a in body.resource_attachments]

    await session.commit()
    await session.refresh(course)

    await write_audit(
        session,
        tenant_id=user.tenant_id,
        actor_type="tenant_admin",
        actor_id=str(user.id),
        actor_email=user.email,
        action="course.update",
        target_type="course",
        target_id=str(course.id),
        details={k: v for k, v in body.model_dump(exclude_none=True).items() if k != "resource_attachments"},
        request=request,
    )
    await session.commit()
    return await _course_to_out(session, course)


@router.post("/{course_id}/publish", response_model=CourseOut)
async def publish_course(
    course_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    course = await _load_owned_course(session, course_id, user.tenant_id)
    course.is_published = True
    await session.commit()
    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email, action="course.publish",
        target_type="course", target_id=str(course.id), request=request,
    )
    await session.commit()
    return await _course_to_out(session, course)


@router.post("/{course_id}/unpublish", response_model=CourseOut)
async def unpublish_course(
    course_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    course = await _load_owned_course(session, course_id, user.tenant_id)
    course.is_published = False
    await session.commit()
    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email, action="course.unpublish",
        target_type="course", target_id=str(course.id), request=request,
    )
    await session.commit()
    return await _course_to_out(session, course)


@router.post("/{course_id}/archive", response_model=CourseOut)
async def archive_course(
    course_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Soft-delete: hide from default lists, but keep enrollment history.
    Existing enrollments stay valid until they expire naturally."""
    _require_admin(user)
    course = await _load_owned_course(session, course_id, user.tenant_id)
    course.is_archived = True
    course.is_published = False
    await session.commit()
    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email, action="course.archive",
        target_type="course", target_id=str(course.id), request=request,
    )
    await session.commit()
    return await _course_to_out(session, course)


@router.post("/{course_id}/unarchive", response_model=CourseOut)
async def unarchive_course(
    course_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    course = await _load_owned_course(session, course_id, user.tenant_id)
    course.is_archived = False
    await session.commit()
    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email, action="course.unarchive",
        target_type="course", target_id=str(course.id), request=request,
    )
    await session.commit()
    return await _course_to_out(session, course)


@router.delete("/{course_id}")
async def delete_course(
    course_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Hard delete. Prefer archive in normal cases; this is irreversible.
    Cascades to course_videos and enrollments via ON DELETE CASCADE."""
    _require_admin(user)
    course = await _load_owned_course(session, course_id, user.tenant_id)
    name = course.name
    await session.delete(course)
    await session.commit()
    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email, action="course.delete",
        target_type="course", target_id=course_id, details={"name": name},
        request=request,
    )
    await session.commit()
    return {"message": "Course deleted", "course_id": course_id}


@router.post("/{course_id}/duplicate", response_model=CourseOut, status_code=201)
async def duplicate_course(
    course_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Clone a course for the next batch — copies metadata + the video list,
    but starts unpublished and with zero enrollments. New name is suffixed " (copy)"."""
    _require_admin(user)
    src = await _load_owned_course(session, course_id, user.tenant_id)

    max_order = await session.scalar(
        select(func.coalesce(func.max(Course.display_order), -1))
        .where(Course.tenant_id == user.tenant_id)
    )

    clone = Course(
        tenant_id=user.tenant_id,
        name=f"{src.name} (copy)",
        description=src.description,
        thumbnail_url=src.thumbnail_url,
        intro_video_id=src.intro_video_id,
        display_order=int(max_order) + 1,
        is_published=False,
        is_archived=False,
        tags=list(src.tags or []),
        resource_attachments=list(src.resource_attachments or []),
    )
    session.add(clone)
    await session.flush()

    src_videos = (await session.execute(
        select(CourseVideo).where(CourseVideo.course_id == src.id)
    )).scalars().all()
    for cv in src_videos:
        session.add(CourseVideo(
            course_id=clone.id,
            video_id=cv.video_id,
            display_order=cv.display_order,
        ))
    await session.commit()
    await session.refresh(clone)

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email, action="course.duplicate",
        target_type="course", target_id=str(clone.id),
        details={"source_course_id": str(src.id), "video_count": len(src_videos)},
        request=request,
    )
    await session.commit()
    return await _course_to_out(session, clone)


# ─── Course videos ──────────────────────────────────────────────────────────

@router.get("/{course_id}/videos", response_model=list[CourseVideoOut])
async def list_course_videos(
    course_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    course = await _load_owned_course(session, course_id, user.tenant_id)

    rows = (await session.execute(
        select(Video, CourseVideo)
        .join(CourseVideo, CourseVideo.video_id == Video.id)
        .where(CourseVideo.course_id == course.id)
        .order_by(CourseVideo.display_order.asc())
    )).all()

    return [
        CourseVideoOut(
            video_id=str(v.id),
            title=v.title,
            qualities=v.qualities or [],
            duration_ms=v.duration_ms,
            status=v.status,
            is_free_preview=v.is_free_preview,
            display_order=cv.display_order,
        )
        for (v, cv) in rows
    ]


class AddVideoToCourse(BaseModel):
    video_id: str
    display_order: int | None = None


@router.post("/{course_id}/videos", status_code=201)
async def add_video_to_course(
    course_id: str,
    body: AddVideoToCourse,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    course = await _load_owned_course(session, course_id, user.tenant_id)
    try:
        vid = uuid.UUID(body.video_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid video_id")
    await _verify_video_in_tenant(session, vid, user.tenant_id)

    existing = (await session.execute(
        select(CourseVideo).where(
            CourseVideo.course_id == course.id, CourseVideo.video_id == vid
        )
    )).scalar_one_or_none()
    if existing is not None:
        return {"message": "Video already in course", "video_id": body.video_id}

    if body.display_order is None:
        max_order = await session.scalar(
            select(func.coalesce(func.max(CourseVideo.display_order), -1))
            .where(CourseVideo.course_id == course.id)
        )
        order_val = int(max_order) + 1
    else:
        order_val = body.display_order

    session.add(CourseVideo(
        course_id=course.id,
        video_id=vid,
        display_order=order_val,
    ))
    await session.commit()

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="course.add_video", target_type="course", target_id=str(course.id),
        details={"video_id": body.video_id, "display_order": order_val},
        request=request,
    )
    await session.commit()
    return {"message": "Video added to course", "video_id": body.video_id, "display_order": order_val}


@router.delete("/{course_id}/videos/{video_id}")
async def remove_video_from_course(
    course_id: str,
    video_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    course = await _load_owned_course(session, course_id, user.tenant_id)
    try:
        vid = uuid.UUID(video_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid video_id")

    cv = (await session.execute(
        select(CourseVideo).where(
            CourseVideo.course_id == course.id, CourseVideo.video_id == vid
        )
    )).scalar_one_or_none()
    if cv is None:
        raise HTTPException(status_code=404, detail="Video not in this course")

    await session.delete(cv)
    await session.commit()
    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="course.remove_video", target_type="course", target_id=str(course.id),
        details={"video_id": video_id}, request=request,
    )
    await session.commit()
    return {"message": "Video removed from course"}


@router.patch("/{course_id}/videos/order")
async def reorder_course_videos(
    course_id: str,
    body: list[CourseVideoOrder],
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Bulk reorder. Body is the new (video_id, display_order) list — only
    videos already in the course are updated; unknown ones are silently
    ignored. Returns the count of updated rows."""
    _require_admin(user)
    course = await _load_owned_course(session, course_id, user.tenant_id)

    updated = 0
    for entry in body:
        try:
            vid = uuid.UUID(entry.video_id)
        except ValueError:
            continue
        cv = (await session.execute(
            select(CourseVideo).where(
                CourseVideo.course_id == course.id, CourseVideo.video_id == vid
            )
        )).scalar_one_or_none()
        if cv is not None:
            cv.display_order = entry.display_order
            updated += 1
    await session.commit()

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="course.reorder_videos", target_type="course", target_id=str(course.id),
        details={"updated_count": updated}, request=request,
    )
    await session.commit()
    return {"message": "Order updated", "updated": updated}


class BulkAssignVideos(BaseModel):
    """v1.5: assign multiple videos to a single course in one round-trip."""
    video_ids: list[str]


@router.post("/{course_id}/videos/bulk-assign")
async def bulk_assign_videos(
    course_id: str,
    body: BulkAssignVideos,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Add many videos to a course in one call. Skips invalids + already-in-course
    silently. Returns counts so the UI can render an honest summary."""
    _require_admin(user)
    course = await _load_owned_course(session, course_id, user.tenant_id)

    # Highest existing display_order — new videos go to the end in input order.
    max_order = await session.scalar(
        select(func.coalesce(func.max(CourseVideo.display_order), -1))
        .where(CourseVideo.course_id == course.id)
    )
    next_order = int(max_order) + 1

    added = 0
    skipped = 0
    invalid: list[str] = []
    for v in body.video_ids:
        try:
            vid = uuid.UUID(v)
        except ValueError:
            invalid.append(v)
            continue
        # Cheap tenant-scope check.
        owned = await session.scalar(
            select(func.count())
            .select_from(Video)
            .where(Video.id == vid, Video.tenant_id == user.tenant_id)
        )
        if not owned:
            invalid.append(v)
            continue
        existing = await session.scalar(
            select(func.count())
            .select_from(CourseVideo)
            .where(CourseVideo.course_id == course.id, CourseVideo.video_id == vid)
        )
        if existing:
            skipped += 1
            continue
        session.add(CourseVideo(
            course_id=course.id, video_id=vid, display_order=next_order,
        ))
        next_order += 1
        added += 1
    await session.commit()

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="course.bulk_assign_videos", target_type="course",
        target_id=str(course.id),
        details={"added": added, "skipped": skipped, "invalid_count": len(invalid)},
        request=request,
    )
    await session.commit()
    return {
        "added": added,
        "skipped_already_in_course": skipped,
        "invalid_or_other_tenant": invalid,
    }
