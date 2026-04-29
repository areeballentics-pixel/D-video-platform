"""Audit log writer — append a row to `audit_logs` whenever a sensitive
admin action happens. Read by the tenant + master audit log viewers.

Append-only; never mutated after creation. Failures here should NOT abort
the parent request — audit logging is best-effort. Callers wrap in try/except.
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit_log import AuditLog

log = logging.getLogger(__name__)


def _client_ip(request: Optional[Request]) -> Optional[str]:
    """Pull the client IP from the FastAPI Request, respecting forwarded headers
    typical of Caddy / Traefik / nginx reverse proxies in our deployment."""
    if request is None:
        return None
    # X-Forwarded-For is a comma-separated chain; the first entry is the
    # original client. Trim and validate length.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        first = fwd.split(",")[0].strip()
        if first:
            return first[:45]
    if request.client and request.client.host:
        return request.client.host[:45]
    return None


async def write_audit(
    session: AsyncSession,
    *,
    tenant_id: Optional[uuid.UUID],
    actor_type: str,
    actor_id: Optional[str],
    actor_email: Optional[str],
    action: str,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    details: Optional[dict] = None,
    request: Optional[Request] = None,
) -> None:
    """Append one audit row. Best-effort: logs the failure rather than raising."""
    try:
        row = AuditLog(
            tenant_id=tenant_id,
            actor_type=actor_type,
            actor_id=actor_id,
            actor_email=actor_email,
            action=action,
            target_type=target_type,
            target_id=target_id,
            details=details or {},
            ip_address=_client_ip(request),
            occurred_at=datetime.now(timezone.utc),
        )
        session.add(row)
        await session.flush()
    except Exception as e:
        log.warning("audit log write failed for action=%s: %s", action, e)
