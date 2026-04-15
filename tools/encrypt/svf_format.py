"""SVF (Secure Video Format) binary format constants and structures.

This defines the .svf file format that both the Python encryption tool
(writer) and the Rust player (reader) must agree on exactly.

See shared/svf_spec.md for the full binary layout documentation.
"""

import struct
from dataclasses import dataclass

# ─── Magic Bytes ───
SVF_MAGIC = b"\x53\x56\x46\x01"  # "SVF" + version tag
SVF_MAGIC_END = b"\x45\x4E\x44\x21"  # "END!"
SVF_VERSION = 1

# ─── Quality Enum ───
QUALITY_MAP = {"480p": 0, "720p": 1, "1080p": 2}
QUALITY_LABELS = {0: "480p", 1: "720p", 2: "1080p"}

# ─── Codec Enum ───
CODEC_H264 = 0

# ─── Default Chunk Size ───
DEFAULT_CHUNK_SIZE = 1_048_576  # 1 MiB


@dataclass
class SvfHeader:
    """Represents the fixed+variable header of an .svf file."""

    version: int
    video_id: bytes  # 16 bytes (UUID)
    tenant_id: bytes  # 16 bytes (UUID)
    encryption_salt: bytes  # 32 bytes
    encryption_nonce: bytes  # 16 bytes
    chunk_size: int
    chunk_count: int
    quality: int  # 0=480p, 1=720p, 2=1080p
    codec: int  # 0=H.264
    width: int
    height: int
    fps_num: int
    fps_den: int
    duration_ms: int
    original_size: int
    encrypted_size: int
    content_hash: bytes  # 32 bytes (SHA-256 of original transcoded file)
    title: str

    def pack_fixed(self) -> bytes:
        """Pack the fixed-size portion of the header."""
        return struct.pack(
            "<4sHH16s16s32s16sIIHHIIIIQQQ32s",
            SVF_MAGIC,
            self.version,
            0,  # flags (reserved)
            self.video_id,
            self.tenant_id,
            self.encryption_salt,
            self.encryption_nonce,
            self.chunk_size,
            self.chunk_count,
            self.quality,
            self.codec,
            self.width,
            self.height,
            self.fps_num,
            self.fps_den,
            self.duration_ms,
            self.original_size,
            self.encrypted_size,
            self.content_hash,
        )

    def pack_title(self) -> bytes:
        """Pack the variable-length title field."""
        title_bytes = self.title.encode("utf-8")[:512]
        return struct.pack("<H", len(title_bytes)) + title_bytes

    # Fixed header size (before title)
    FIXED_SIZE = struct.calcsize("<4sHH16s16s32s16sIIHHIIIIQQQ32s")


@dataclass
class ChunkIndexEntry:
    """One entry in the chunk index table."""

    offset: int  # Absolute file offset (u64)
    encrypted_size: int  # Size of encrypted chunk (u32)
    hash: bytes  # SHA-256 of encrypted chunk (32 bytes)

    ENTRY_SIZE = 8 + 4 + 32  # 44 bytes

    def pack(self) -> bytes:
        return struct.pack("<QI32s", self.offset, self.encrypted_size, self.hash)
