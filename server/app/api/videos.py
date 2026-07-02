"""Player-facing video endpoints — license + key delivery + key bundle.

The player's flow on play-button click:
  1. POST /api/videos/key  →  { key, download_url, content_hash, file_size, ... }
  2. If local .svf doesn't exist, fetch from download_url (institute-hosted),
     verify content_hash, decrypt with key.

The /key endpoint also serves as the access-control gate; it raises 403 if
the student isn't enrolled in any course containing the video.
"""

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.database import get_db
from app.models.user import User
from app.models.video import Video
from app.schemas.license import VideoKeyRequest
from app.services.key_service import (
    DeviceMismatch,
    LicenseInvalid,
    VideoNotFound,
    get_user_licensed_keys,
    get_video_key,
)


router = APIRouter()
logger = logging.getLogger(__name__)


class VideoKeyResponse(BaseModel):
    key: str                # hex-encoded 32-byte AES key for this (video, quality)
    quality: str
    download_url: str | None  # institute-hosted .svf URL; None = institute hasn't published yet
    content_hash: str | None  # hex SHA-256 of the original (pre-encrypt) source for verification
    file_size: int | None     # .svf size in bytes
    is_stream_only: bool
    chapters: list


@router.post("/key", response_model=VideoKeyResponse)
async def get_video_key_endpoint(
    body: VideoKeyRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Validate access + return decryption key + download metadata."""
    # DIAGNOSTIC (temp): log every key request so we can compare a working play
    # vs a failing replay (same video_id/quality? or different?).
    logger.info(
        "videos/key REQUEST video_id=%s quality=%s user=%s tenant=%s fp=%s",
        body.video_id, body.quality, user.id, user.tenant_id,
        (body.device_fingerprint or "")[:12],
    )
    try:
        hex_key = await get_video_key(
            session,
            user,
            video_id_str=body.video_id,
            quality=body.quality,
            device_fingerprint=body.device_fingerprint,
        )
    except VideoNotFound as e:
        # DIAGNOSTIC (temp): why did this 404? Does the video exist at all,
        # vs in the caller's tenant? Distinguishes "unknown id" from "salt gap".
        try:
            _vid = uuid.UUID(body.video_id)
            _any = await session.scalar(
                select(func.count()).select_from(Video).where(Video.id == _vid)
            )
            _mine = await session.scalar(
                select(func.count()).select_from(Video).where(
                    Video.id == _vid, Video.tenant_id == user.tenant_id
                )
            )
        except Exception:
            _any = _mine = "?"
        logger.warning(
            "videos/key 404 reason=%r video_id=%s quality=%s user=%s tenant=%s "
            "exists_any=%s exists_in_tenant=%s",
            str(e), body.video_id, body.quality, user.id, user.tenant_id, _any, _mine,
        )
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except DeviceMismatch as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except LicenseInvalid as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    # Pull download metadata for the player.
    try:
        vid = uuid.UUID(body.video_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid video_id")

    video = (await session.execute(
        select(Video).where(Video.id == vid, Video.tenant_id == user.tenant_id)
    )).scalar_one()

    return VideoKeyResponse(
        key=hex_key,
        quality=body.quality,
        download_url=(video.download_urls or {}).get(body.quality),
        content_hash=(video.content_hashes or {}).get(body.quality),
        file_size=(video.file_sizes or {}).get(body.quality),
        is_stream_only=video.is_stream_only,
        chapters=video.chapters or [],
    )


class LicensedKeyOut(BaseModel):
    video_id: str
    quality: str
    key: str
    download_url: str | None = None
    content_hash: str | None = None
    file_size: int | None = None


@router.get("/licensed-keys")
async def list_licensed_keys(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Return the bundle of (video, quality, key, download_url, ...) the user
    is currently licensed for. Player calls this after login so it can play
    any of the user's videos fully offline (within the grace period)."""
    bundle = await get_user_licensed_keys(session, user)

    # Augment with download metadata so the player can fetch and verify
    # without a separate /key call per video.
    if not bundle:
        return {"keys": []}

    video_ids = list({uuid.UUID(b["video_id"]) for b in bundle})
    videos = (await session.execute(
        select(Video).where(Video.id.in_(video_ids))
    )).scalars().all()
    by_id = {v.id.hex: v for v in videos}

    enriched = []
    for entry in bundle:
        v = by_id.get(entry["video_id"])
        q = entry["quality"]
        enriched.append({
            "video_id": entry["video_id"],
            "quality": q,
            "key": entry["key"],
            "download_url": (v.download_urls or {}).get(q) if v else None,
            "content_hash": (v.content_hashes or {}).get(q) if v else None,
            "file_size": (v.file_sizes or {}).get(q) if v else None,
        })
    return {"keys": enriched}


@router.get("/")
async def list_videos():
    """Deprecated stub — use /licensed-keys for the player or /api/admin/videos for admin."""
    return {"videos": []}
