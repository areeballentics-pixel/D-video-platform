"""Audit log viewer — tenant admins see their own tenant's logs.

Append-only; no edit/delete from the API. Append happens via
`app.services.audit_service.write_audit` from elsewhere.
"""

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.user import User


router = APIRouter()


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")


class AuditOut(BaseModel):
    id: str
    actor_type: str
    actor_email: Optional[str]
    action: str
    target_type: Optional[str]
    target_id: Optional[str]
    details: dict
    ip_address: Optional[str]
    occurred_at: str


@router.get("", response_model=list[AuditOut])
async def list_audit(
    action: Optional[str] = None,
    actor_email: Optional[str] = None,
    target_type: Optional[str] = None,
    since_days: int = 30,
    limit: int = 200,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Most-recent-first audit entries for the caller's tenant.

    Filters: action prefix match, actor email exact, target type exact, and
    a `since_days` time window (default 30). `limit` is capped at 1000.
    """
    _require_admin(user)
    limit = max(1, min(limit, 1000))

    cutoff = datetime.now(timezone.utc).fromtimestamp(
        max(0, datetime.now(timezone.utc).timestamp() - since_days * 86400),
        tz=timezone.utc,
    )

    q = select(AuditLog).where(
        AuditLog.tenant_id == user.tenant_id,
        AuditLog.occurred_at >= cutoff,
    )
    if action:
        # Allow prefix-matching, e.g. action=encryptor.* — postgres ILIKE
        if action.endswith(".*"):
            q = q.where(AuditLog.action.like(action[:-1] + "%"))
        else:
            q = q.where(AuditLog.action == action)
    if actor_email:
        q = q.where(AuditLog.actor_email == actor_email)
    if target_type:
        q = q.where(AuditLog.target_type == target_type)

    q = q.order_by(desc(AuditLog.occurred_at)).limit(limit)
    rows = (await session.execute(q)).scalars().all()

    return [
        AuditOut(
            id=str(r.id),
            actor_type=r.actor_type,
            actor_email=r.actor_email,
            action=r.action,
            target_type=r.target_type,
            target_id=r.target_id,
            details=r.details or {},
            ip_address=r.ip_address,
            occurred_at=r.occurred_at.isoformat(),
        )
        for r in rows
    ]
