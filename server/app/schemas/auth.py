"""Auth request/response schemas."""

from pydantic import BaseModel


class LoginRequest(BaseModel):
    # Plain `str`, not `EmailStr` — pydantic's email-validator rejects
    # `.local`, `.internal`, etc. per RFC 6761, which trips up institutes
    # using internal-only email domains. The DB unique constraint on
    # `(tenant_id, email)` still prevents duplicates; format-shaping is a
    # UX-layer concern, not a security one.
    email: str
    password: str
    device_fingerprint: str
    hostname: str = ""
    os_version: str = ""


class LoginWithKeyRequest(BaseModel):
    license_key: str
    device_fingerprint: str
    hostname: str = ""
    os_version: str = ""


class VideoKeyEntry(BaseModel):
    """One decryption key in the offline bundle."""
    video_id: str   # hex (32 chars, no dashes — matches uuid.bytes hex-encoded)
    quality: str    # "480p" / "720p" / "1080p"
    key: str        # hex-encoded 32-byte derived key


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user_id: str
    email: str
    tenant_id: str
    # Per-license key bundle for offline playback. Contains derived keys ONLY
    # for videos this user is licensed to access. The tenant master key is
    # never sent — limiting the blast radius of a device compromise to this
    # user's own licensed content.
    licensed_video_keys: list[VideoKeyEntry] = []


class RefreshRequest(BaseModel):
    refresh_token: str
