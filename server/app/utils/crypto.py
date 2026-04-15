"""Cryptographic utilities — HKDF key derivation for video encryption."""

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

    This MUST produce identical output to the Rust implementation in crypto.rs.

    Args:
        master_key: 32-byte tenant master key
        salt: 32-byte random salt (stored in .svf header)
        video_id: 16-byte UUID
        tenant_id: 16-byte UUID
        quality: Quality level as int (0=480p, 1=720p, 2=1080p)

    Returns:
        32-byte derived key
    """
    # Build the info parameter: video_id || tenant_id || quality (LE u16)
    info = video_id + tenant_id + quality.to_bytes(2, "little")

    hkdf = HKDF(
        algorithm=SHA256(),
        length=32,
        salt=salt,
        info=info,
    )
    return hkdf.derive(master_key)
