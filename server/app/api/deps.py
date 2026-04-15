"""FastAPI dependencies — authentication, authorisation helpers."""

import uuid

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import verify_token
from app.database import get_db
from app.models.platform_admin import PlatformAdmin
from app.models.tenant import Tenant
from app.models.user import User

bearer_scheme = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    session: AsyncSession = Depends(get_db),
) -> User:
    """Extract and verify the Bearer token, then load the User from the database.

    Also enforces tenant suspension: if the user's tenant has been deactivated
    by a platform admin, every tenant-scoped API call is rejected with 403.
    """
    token = credentials.credentials
    try:
        payload = verify_token(token)
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if payload.get("type") != "access":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type — expected access token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id_str = payload.get("sub")
    if not user_id_str:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing subject claim",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        user_id = uuid.UUID(user_id_str)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid user id in token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    result = await session.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Enforce tenant-level suspension. If a platform admin has suspended
    # this user's tenant, cut off all API access immediately. The
    # player's offline cache still works up to the grace period — that
    # tail is an inherent property of offline-first design.
    tenant_result = await session.execute(
        select(Tenant).where(Tenant.id == user.tenant_id)
    )
    tenant = tenant_result.scalar_one_or_none()
    if tenant is None or not tenant.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account has been suspended. Please contact support.",
        )

    return user


async def get_current_master_admin(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    session: AsyncSession = Depends(get_db),
) -> PlatformAdmin:
    """Dependency for /api/master/* endpoints.

    Rejects any token whose `type` claim isn't exactly "master_access", so a
    compromised tenant-admin token cannot be used to call master endpoints.
    """
    token = credentials.credentials
    try:
        payload = verify_token(token)
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if payload.get("type") != "master_access":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not a platform admin token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    admin_id_str = payload.get("sub")
    if not admin_id_str:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing subject claim",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        admin_id = uuid.UUID(admin_id_str)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid admin id in token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    result = await session.execute(
        select(PlatformAdmin).where(PlatformAdmin.id == admin_id)
    )
    admin = result.scalar_one_or_none()
    if admin is None or not admin.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Platform admin not found or inactive",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return admin
