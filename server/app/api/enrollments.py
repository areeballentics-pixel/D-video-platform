"""Enrollment management — grant + revoke + bulk + CSV import.

Replaces the v0 wildcard-license auto-grant. All admin-side. Enrollment
queries from the player still go through `key_service.validate_license`
(which now joins on this table)."""

import csv
import io
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.security import hash_password
from app.database import get_db
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.user import User
from app.services.audit_service import write_audit


router = APIRouter()


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")


# ─── Schemas ────────────────────────────────────────────────────────────────

class EnrollmentCreate(BaseModel):
    user_id: str
    course_id: str
    expires_at: Optional[datetime] = None


class BulkEnrollRequest(BaseModel):
    user_ids: list[str]
    course_ids: list[str]
    expires_at: Optional[datetime] = None


class EnrollmentOut(BaseModel):
    id: str
    user_id: str
    user_email: str
    course_id: str
    course_name: str
    enrolled_at: str
    expires_at: Optional[str]
    is_active: bool


class CSVImportSummary(BaseModel):
    total_rows: int
    created_users: int
    skipped_existing_users: int
    enrollments_created: int
    errors: list[str]


# ─── Helpers ────────────────────────────────────────────────────────────────

async def _verify_user_in_tenant(
    session: AsyncSession, user_id: uuid.UUID, tenant_id: uuid.UUID
) -> User:
    u = (await session.execute(
        select(User).where(User.id == user_id, User.tenant_id == tenant_id)
    )).scalar_one_or_none()
    if u is None:
        raise HTTPException(status_code=404, detail=f"User {user_id} not in this tenant")
    return u


async def _verify_course_in_tenant(
    session: AsyncSession, course_id: uuid.UUID, tenant_id: uuid.UUID
) -> Course:
    c = (await session.execute(
        select(Course).where(Course.id == course_id, Course.tenant_id == tenant_id)
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail=f"Course {course_id} not in this tenant")
    return c


async def _upsert_enrollment(
    session: AsyncSession,
    user_id: uuid.UUID,
    course_id: uuid.UUID,
    enrolled_by_user_id: uuid.UUID,
    expires_at: Optional[datetime],
) -> tuple[Enrollment, bool]:
    """Create OR re-activate an enrollment. Returns (row, was_created)."""
    existing = (await session.execute(
        select(Enrollment).where(
            Enrollment.user_id == user_id, Enrollment.course_id == course_id
        )
    )).scalar_one_or_none()
    if existing is not None:
        was_reactivated = not existing.is_active
        existing.is_active = True
        existing.expires_at = expires_at
        existing.enrolled_by_user_id = enrolled_by_user_id
        # Only refresh enrolled_at on a genuine re-enrollment (was revoked). A
        # no-op re-POST on an already-active enrollment must NOT rewrite the
        # original enrollment date.
        if was_reactivated:
            existing.enrolled_at = datetime.now(timezone.utc)
        return existing, False

    e = Enrollment(
        user_id=user_id,
        course_id=course_id,
        expires_at=expires_at,
        enrolled_by_user_id=enrolled_by_user_id,
        is_active=True,
    )
    session.add(e)
    await session.flush()
    return e, True


async def _to_enrollment_out(session: AsyncSession, e: Enrollment) -> EnrollmentOut:
    u = (await session.execute(select(User).where(User.id == e.user_id))).scalar_one()
    c = (await session.execute(select(Course).where(Course.id == e.course_id))).scalar_one()
    return EnrollmentOut(
        id=str(e.id),
        user_id=str(e.user_id),
        user_email=u.email,
        course_id=str(e.course_id),
        course_name=c.name,
        enrolled_at=e.enrolled_at.isoformat(),
        expires_at=e.expires_at.isoformat() if e.expires_at else None,
        is_active=e.is_active,
    )


# ─── Endpoints ──────────────────────────────────────────────────────────────

@router.post("", response_model=EnrollmentOut, status_code=201)
async def create_enrollment(
    body: EnrollmentCreate,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    try:
        uid = uuid.UUID(body.user_id)
        cid = uuid.UUID(body.course_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid user_id or course_id")

    student = await _verify_user_in_tenant(session, uid, user.tenant_id)
    await _verify_course_in_tenant(session, cid, user.tenant_id)

    enrollment, was_created = await _upsert_enrollment(
        session, uid, cid, user.id, body.expires_at
    )
    # A no-op / reactivation is not a newly created resource → 200, not 201.
    if not was_created:
        response.status_code = 200
    await session.commit()
    await session.refresh(enrollment)

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="enrollment.create" if was_created else "enrollment.reactivate",
        target_type="enrollment", target_id=str(enrollment.id),
        details={"student_email": student.email, "course_id": body.course_id},
        request=request,
    )
    await session.commit()
    return await _to_enrollment_out(session, enrollment)


@router.post("/bulk")
async def bulk_enroll(
    body: BulkEnrollRequest,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Enroll N students into M courses (N×M enrollments). Skips invalid IDs
    silently and reports counts."""
    _require_admin(user)

    user_uuids: list[uuid.UUID] = []
    for s in body.user_ids:
        try:
            user_uuids.append(uuid.UUID(s))
        except ValueError:
            continue
    course_uuids: list[uuid.UUID] = []
    for s in body.course_ids:
        try:
            course_uuids.append(uuid.UUID(s))
        except ValueError:
            continue

    valid_users = (await session.execute(
        select(User.id).where(User.id.in_(user_uuids), User.tenant_id == user.tenant_id)
    )).scalars().all()
    valid_courses = (await session.execute(
        select(Course.id).where(
            Course.id.in_(course_uuids), Course.tenant_id == user.tenant_id
        )
    )).scalars().all()

    created = 0
    reactivated = 0
    for uid in valid_users:
        for cid in valid_courses:
            _e, was_created = await _upsert_enrollment(
                session, uid, cid, user.id, body.expires_at
            )
            if was_created:
                created += 1
            else:
                reactivated += 1
    await session.commit()

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="enrollment.bulk_create",
        target_type="bulk", target_id=None,
        details={
            "user_count": len(valid_users),
            "course_count": len(valid_courses),
            "created": created,
            "reactivated": reactivated,
        },
        request=request,
    )
    await session.commit()
    return {
        "users_processed": len(valid_users),
        "courses_processed": len(valid_courses),
        "enrollments_created": created,
        "enrollments_reactivated": reactivated,
    }


@router.delete("/{enrollment_id}")
async def revoke_enrollment(
    enrollment_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Soft-revoke: flips is_active=False. Player loses access at next license
    check; in-flight playback continues until the offline grace period expires."""
    _require_admin(user)
    try:
        eid = uuid.UUID(enrollment_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid enrollment_id")

    # Join with User to enforce tenant scoping (enrollments table has no tenant_id).
    enrollment = (await session.execute(
        select(Enrollment).join(User, User.id == Enrollment.user_id).where(
            Enrollment.id == eid, User.tenant_id == user.tenant_id
        )
    )).scalar_one_or_none()
    if enrollment is None:
        raise HTTPException(status_code=404, detail="Enrollment not found")

    enrollment.is_active = False
    await session.commit()

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="enrollment.revoke",
        target_type="enrollment", target_id=enrollment_id,
        request=request,
    )
    await session.commit()
    return {"message": "Enrollment revoked", "enrollment_id": enrollment_id}


@router.get("/by-student/{user_id}", response_model=list[EnrollmentOut])
async def list_student_enrollments(
    user_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid user_id")
    await _verify_user_in_tenant(session, uid, user.tenant_id)

    rows = (await session.execute(
        select(Enrollment).where(Enrollment.user_id == uid)
        .order_by(Enrollment.enrolled_at.desc())
    )).scalars().all()
    return [await _to_enrollment_out(session, e) for e in rows]


@router.get("/by-course/{course_id}", response_model=list[EnrollmentOut])
async def list_course_enrollments(
    course_id: str,
    active_only: bool = True,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    try:
        cid = uuid.UUID(course_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid course_id")
    await _verify_course_in_tenant(session, cid, user.tenant_id)

    q = select(Enrollment).where(Enrollment.course_id == cid)
    if active_only:
        now = datetime.now(timezone.utc)
        q = q.where(
            Enrollment.is_active.is_(True),
            or_(Enrollment.expires_at.is_(None), Enrollment.expires_at > now),
        )
    q = q.order_by(Enrollment.enrolled_at.desc())

    rows = (await session.execute(q)).scalars().all()
    return [await _to_enrollment_out(session, e) for e in rows]


@router.post("/import-csv", response_model=CSVImportSummary)
async def import_csv(
    file: UploadFile = File(...),
    request: Request = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Bulk import students + enrollments from a CSV.

    CSV columns (header required):
      email           — student's email (unique per tenant)
      password        — initial password (will be bcrypt-hashed)
      courses         — comma-separated course names within this tenant; whitespace ignored

    Existing emails are skipped (no overwrite). Unknown course names are
    reported in `errors` but don't abort the row.
    """
    _require_admin(user)

    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")  # tolerate BOM
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="CSV must be UTF-8 encoded")

    reader = csv.DictReader(io.StringIO(text))
    required = {"email", "password", "courses"}
    if not reader.fieldnames or not required.issubset(set(c.strip() for c in reader.fieldnames)):
        raise HTTPException(
            status_code=400,
            detail=f"CSV must have columns: {sorted(required)}",
        )

    # Pre-load tenant courses by lowercased name for fast lookup.
    courses = (await session.execute(
        select(Course).where(Course.tenant_id == user.tenant_id)
    )).scalars().all()
    course_by_name = {c.name.strip().lower(): c for c in courses}

    summary = CSVImportSummary(
        total_rows=0,
        created_users=0,
        skipped_existing_users=0,
        enrollments_created=0,
        errors=[],
    )

    for row_num, row in enumerate(reader, start=2):  # 1 = header line
        summary.total_rows += 1
        email = (row.get("email") or "").strip().lower()
        password = (row.get("password") or "").strip()
        course_csv = (row.get("courses") or "").strip()

        if not email or not password:
            summary.errors.append(f"row {row_num}: missing email or password")
            continue

        # Find or create the student.
        existing = (await session.execute(
            select(User).where(
                User.tenant_id == user.tenant_id, User.email == email
            )
        )).scalar_one_or_none()

        if existing is None:
            student = User(
                tenant_id=user.tenant_id,
                email=email,
                password_hash=hash_password(password),
                license_key=(
                    f"{uuid.uuid4().hex[:4].upper()}-"
                    f"{uuid.uuid4().hex[:4].upper()}-"
                    f"{uuid.uuid4().hex[:4].upper()}-"
                    f"{uuid.uuid4().hex[:4].upper()}"
                ),
                role="student",
            )
            session.add(student)
            await session.flush()
            summary.created_users += 1
            student_id = student.id
        else:
            summary.skipped_existing_users += 1
            student_id = existing.id

        # Enroll into each named course.
        for raw_name in course_csv.split(","):
            name = raw_name.strip().lower()
            if not name:
                continue
            course = course_by_name.get(name)
            if course is None:
                summary.errors.append(f"row {row_num}: unknown course '{raw_name.strip()}'")
                continue
            _e, was_created = await _upsert_enrollment(
                session, student_id, course.id, user.id, expires_at=None
            )
            if was_created:
                summary.enrollments_created += 1

    await session.commit()

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="enrollment.csv_import",
        target_type="bulk", target_id=None,
        details={
            "filename": file.filename,
            "total_rows": summary.total_rows,
            "created_users": summary.created_users,
            "enrollments_created": summary.enrollments_created,
            "errors": summary.errors[:20],  # cap audit log size
        },
        request=request,
    )
    await session.commit()
    return summary


class EnrollmentUpdate(BaseModel):
    """v1.5: edit an existing enrollment's expiry date."""
    expires_at: Optional[datetime] = None


@router.patch("/{enrollment_id}", response_model=EnrollmentOut)
async def update_enrollment(
    enrollment_id: str,
    body: EnrollmentUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Edit an enrollment — currently just `expires_at`. Set to null to remove
    the expiry. Reactivates a revoked enrollment as a side-effect."""
    _require_admin(user)
    try:
        eid = uuid.UUID(enrollment_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid enrollment_id")

    enrollment = (await session.execute(
        select(Enrollment).join(User, User.id == Enrollment.user_id).where(
            Enrollment.id == eid, User.tenant_id == user.tenant_id
        )
    )).scalar_one_or_none()
    if enrollment is None:
        raise HTTPException(status_code=404, detail="Enrollment not found")

    enrollment.expires_at = body.expires_at
    enrollment.is_active = True
    await session.commit()
    await session.refresh(enrollment)

    await write_audit(
        session, tenant_id=user.tenant_id, actor_type="tenant_admin",
        actor_id=str(user.id), actor_email=user.email,
        action="enrollment.update_expiry",
        target_type="enrollment", target_id=str(enrollment.id),
        details={"expires_at": body.expires_at.isoformat() if body.expires_at else None},
        request=request,
    )
    await session.commit()
    return await _to_enrollment_out(session, enrollment)
