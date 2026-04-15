"""Video request/response schemas."""

from pydantic import BaseModel


class VideoRegisterRequest(BaseModel):
    """Used by the CLI encryption tool to register a newly encrypted video."""
    video_id: str
    tenant_id: str
    title: str
    qualities: list[str]
    encryption_salt: str  # hex-encoded
    encryption_nonce: str  # hex-encoded
    duration_ms: int


class VideoResponse(BaseModel):
    video_id: str
    title: str
    description: str
    qualities: list[str]
    duration_ms: int
