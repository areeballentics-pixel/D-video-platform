"""Auth endpoints — login, logout, token refresh."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from jose import JWTError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.config import settings
from app.core.redis import get_redis
from app.core.security import create_access_token, verify_token
from app.database import get_db
from app.models.user import User
from app.schemas.auth import (
    LoginRequest,
    LoginWithKeyRequest,
    RefreshRequest,
    TokenResponse,
)
from app.services.auth_service import (
    DeviceLimitExceeded,
    authenticate_by_key,
    authenticate_user,
    create_tokens,
    register_device_on_login,
)

router = APIRouter()


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, session: AsyncSession = Depends(get_db)):
    """Login with email + password. Registers the device and returns JWT tokens."""
    user = await authenticate_user(session, body.email, body.password)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    try:
        await register_device_on_login(
            session,
            user,
            fingerprint=body.device_fingerprint,
            hostname=body.hostname,
            os_version=body.os_version,
        )
    except DeviceLimitExceeded as e:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(e),
        )

    tokens = await create_tokens(user, session)
    return TokenResponse(**tokens)


@router.post("/login-key", response_model=TokenResponse)
async def login_with_key(
    body: LoginWithKeyRequest, session: AsyncSession = Depends(get_db)
):
    """Login with license key. Registers the device and returns JWT tokens."""
    user = await authenticate_by_key(session, body.license_key)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid license key",
        )

    try:
        await register_device_on_login(
            session,
            user,
            fingerprint=body.device_fingerprint,
            hostname=body.hostname,
            os_version=body.os_version,
        )
    except DeviceLimitExceeded as e:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(e),
        )

    tokens = await create_tokens(user, session)
    return TokenResponse(**tokens)


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(body: RefreshRequest, session: AsyncSession = Depends(get_db)):
    """Refresh an access token using a valid refresh token."""
    try:
        payload = verify_token(body.refresh_token)
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )

    if payload.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type — expected refresh token",
        )

    jti = payload.get("jti")
    user_id_str = payload.get("sub")
    if not jti or not user_id_str:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Malformed refresh token",
        )

    # Check that the refresh token has not been revoked
    redis = get_redis()
    stored = await redis.get(f"refresh:{jti}")
    if stored is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token has been revoked",
        )

    # Load the user
    from sqlalchemy import select
    from app.models.user import User as UserModel

    try:
        uid = uuid.UUID(user_id_str)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid user id in token",
        )

    result = await session.execute(
        select(UserModel).where(UserModel.id == uid)
    )
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive",
        )

    # Issue new tokens (rotate refresh token)
    # Revoke old refresh token
    await redis.delete(f"refresh:{jti}")

    tokens = await create_tokens(user, session)
    return TokenResponse(**tokens)


@router.post("/logout")
async def logout(user: User = Depends(get_current_user)):
    """Invalidate all refresh tokens for the current user.

    Note: the access token itself remains valid until it expires (short-lived),
    but the refresh token stored in Redis is removed so no new access tokens
    can be minted.
    """
    redis = get_redis()
    # We scan for keys matching refresh:* that map to this user_id and delete them.
    # This is a simple approach; for high-scale production you would track JTIs per user.
    cursor = None
    user_id_str = str(user.id)
    deleted = 0
    cursor = "0"
    while True:
        cursor, keys = await redis.scan(cursor=cursor, match="refresh:*", count=100)
        for key in keys:
            value = await redis.get(key)
            if value == user_id_str:
                await redis.delete(key)
                deleted += 1
        if cursor == 0 or cursor == "0":
            break

    return {"message": "Logged out", "tokens_revoked": deleted}
