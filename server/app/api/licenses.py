"""License endpoints — validation."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.config import settings
from app.database import get_db
from app.models.user import User
from app.schemas.license import LicenseValidateRequest, LicenseValidateResponse
from app.services.key_service import DeviceMismatch, LicenseInvalid, VideoNotFound, validate_license

import uuid

router = APIRouter()


@router.post("/validate", response_model=LicenseValidateResponse)
async def validate_license_endpoint(
    body: LicenseValidateRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Validate that the current user has a license for the given video + device."""
    try:
        video_uuid = uuid.UUID(body.video_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid video ID format",
        )

    try:
        await validate_license(session, user, video_uuid, body.device_fingerprint)
    except DeviceMismatch as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        )
    except LicenseInvalid as e:
        return LicenseValidateResponse(
            valid=False,
            message=str(e),
            offline_grace_days=0,
        )

    return LicenseValidateResponse(
        valid=True,
        offline_grace_days=settings.DEFAULT_OFFLINE_GRACE_DAYS,
        message="License valid",
    )
