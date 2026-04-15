"""Video endpoints — key delivery and listing."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.database import get_db
from app.models.user import User
from app.schemas.license import VideoKeyRequest, VideoKeyResponse
from app.services.key_service import (
    DeviceMismatch,
    LicenseInvalid,
    VideoNotFound,
    get_video_key,
)

router = APIRouter()


@router.post("/key", response_model=VideoKeyResponse)
async def get_video_key_endpoint(
    body: VideoKeyRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Get the decryption key for a video. Requires a valid license and registered device."""
    try:
        hex_key = await get_video_key(
            session,
            user,
            video_id_str=body.video_id,
            quality=body.quality,
            device_fingerprint=body.device_fingerprint,
        )
    except VideoNotFound as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
    except DeviceMismatch as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        )
    except LicenseInvalid as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    return VideoKeyResponse(key=hex_key)


@router.get("/")
async def list_videos():
    """List available videos for the current user's license."""
    # TODO (Sprint 6): Implement full video listing with license filtering
    return {"videos": []}
