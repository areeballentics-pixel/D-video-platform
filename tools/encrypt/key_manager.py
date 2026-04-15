"""Key derivation for video encryption — must match Rust implementation exactly."""

from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def derive_video_key(
    master_key: bytes,
    salt: bytes,
    video_id: bytes,
    tenant_id: bytes,
    quality: int,
) -> bytes:
    """
    Derive a per-video encryption key using HKDF-SHA256.

    CRITICAL: This must produce byte-identical output to:
      - Rust: crypto.rs SecureKey::derive_video_key()
      - Python server: app/utils/crypto.py derive_video_key()

    The 'info' parameter is: video_id (16 bytes) || tenant_id (16 bytes) || quality (2 bytes LE)

    Args:
        master_key: 32-byte tenant master key
        salt: 32-byte random salt
        video_id: 16-byte UUID (raw bytes, not hex string)
        tenant_id: 16-byte UUID (raw bytes, not hex string)
        quality: 0=480p, 1=720p, 2=1080p

    Returns:
        32-byte derived AES key
    """
    info = video_id + tenant_id + quality.to_bytes(2, "little")

    hkdf = HKDF(
        algorithm=SHA256(),
        length=32,
        salt=salt,
        info=info,
    )
    return hkdf.derive(master_key)
