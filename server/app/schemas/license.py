"""License request/response schemas."""

from pydantic import BaseModel


class LicenseValidateRequest(BaseModel):
    video_id: str
    device_fingerprint: str


class LicenseValidateResponse(BaseModel):
    valid: bool
    license_token: str | None = None
    offline_grace_days: int = 20
    message: str = ""


class VideoKeyRequest(BaseModel):
    video_id: str
    quality: str  # "480p", "720p", "1080p"
    device_fingerprint: str


class VideoKeyResponse(BaseModel):
    key: str  # hex-encoded 32-byte key
