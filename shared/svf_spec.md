# SVF (Secure Video Format) Specification v1

## Overview

`.svf` is a custom binary container format for encrypted video content.
One file per quality level (e.g., `{uuid}_720p.svf`).

## Binary Layout

```
HEADER (fixed portion):
  Offset  Size    Type      Field
  0x00    4B      bytes     magic = 0x53 0x56 0x46 0x01 ("SVF\x01")
  0x04    2B      u16 LE    version = 0x0001
  0x06    2B      u16 LE    flags (reserved, must be 0)
  0x08    16B     bytes     video_id (UUID v4 raw bytes)
  0x18    16B     bytes     tenant_id (UUID v4 raw bytes)
  0x28    32B     bytes     encryption_salt (random, for HKDF)
  0x48    16B     bytes     encryption_nonce (AES-CTR base nonce)
  0x58    4B      u32 LE    chunk_size (default: 1,048,576 = 1 MiB)
  0x5C    4B      u32 LE    chunk_count
  0x60    2B      u16 LE    quality (0=480p, 1=720p, 2=1080p)
  0x62    2B      u16 LE    codec (0=H.264, 1=H.265 future)
  0x64    4B      u32 LE    width (pixels)
  0x68    4B      u32 LE    height (pixels)
  0x6C    4B      u32 LE    fps_num (framerate numerator)
  0x70    4B      u32 LE    fps_den (framerate denominator)
  0x74    8B      u64 LE    duration_ms
  0x7C    8B      u64 LE    original_size (pre-encryption)
  0x84    8B      u64 LE    encrypted_size (total encrypted data)
  0x8C    32B     bytes     content_hash (SHA-256 of original transcoded file)

HEADER (variable portion):
  0xAC    2B      u16 LE    title_length
  0xAE    var     UTF-8     title (max 512 bytes)

After title:
          4B      u32 LE    chunk_index_offset (absolute offset to chunk index table)

CHUNK INDEX TABLE (at chunk_index_offset):
  Per entry (44 bytes each, chunk_count entries):
    8B    u64 LE    chunk_data_offset (absolute file offset)
    4B    u32 LE    chunk_encrypted_size
    32B   bytes     chunk_hash (SHA-256 of encrypted chunk data)

ENCRYPTED CHUNK DATA:
  chunk_count chunks, each encrypted with AES-256-CTR

FILE FOOTER:
  32B   bytes     file_hash (SHA-256 of all bytes from 0x00 to end of last chunk)
  4B    bytes     magic_end = 0x45 0x4E 0x44 0x21 ("END!")
```

## Key Derivation

```
Per-Video Key = HKDF-SHA256(
    ikm  = master_key (32 bytes, per-tenant),
    salt = encryption_salt (32 bytes, from header),
    info = video_id (16B) || tenant_id (16B) || quality (2B LE),
    len  = 32 bytes
)
```

## Per-Chunk Nonce

```
chunk_nonce = encryption_nonce XOR (chunk_index as u128 LE, zero-padded to 16 bytes)
```

Each chunk uses AES-256-CTR with the per-video key and its unique chunk_nonce.
The CTR counter within each chunk starts at 0.

## Integrity

- Each chunk's SHA-256 hash is stored in the chunk index table
- The file footer contains a SHA-256 hash of the entire file (header + index + chunks)
- Readers SHOULD verify chunk hashes before decryption
- Readers MAY verify the file hash on import (slower, optional)
