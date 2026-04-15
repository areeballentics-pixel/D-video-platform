"""SVF decryption verifier — proves the .svf format is round-trip correct.

Reads a .svf file, parses the binary header, derives the key, decrypts all
chunks, and verifies the decrypted output is a valid video. This validates
the entire pipeline before we implement the Rust parser.

Usage:
    python -m encrypt.verify <svf_file> --master-key <hex>
    python -m encrypt.verify <svf_file> --master-key <hex> --save-decrypted out.mp4
"""

import hashlib
import struct
import sys
from pathlib import Path

import click

from .encryptor import _derive_chunk_nonce
from .key_manager import derive_video_key
from .svf_format import (
    SVF_MAGIC,
    SVF_MAGIC_END,
    SVF_VERSION,
    QUALITY_LABELS,
    ChunkIndexEntry,
    SvfHeader,
)

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def parse_svf_header(f) -> tuple[SvfHeader, list[ChunkIndexEntry]]:
    """Parse the binary header and chunk index from an open .svf file."""

    # Read and validate magic bytes
    magic = f.read(4)
    if magic != SVF_MAGIC:
        raise ValueError(f"Invalid magic bytes: {magic.hex()} (expected {SVF_MAGIC.hex()})")

    # Read fixed header fields
    version = struct.unpack("<H", f.read(2))[0]
    if version != SVF_VERSION:
        raise ValueError(f"Unsupported version: {version}")

    flags = struct.unpack("<H", f.read(2))[0]
    video_id = f.read(16)
    tenant_id = f.read(16)
    encryption_salt = f.read(32)
    encryption_nonce = f.read(16)
    chunk_size = struct.unpack("<I", f.read(4))[0]
    chunk_count = struct.unpack("<I", f.read(4))[0]
    quality = struct.unpack("<H", f.read(2))[0]
    codec = struct.unpack("<H", f.read(2))[0]
    width = struct.unpack("<I", f.read(4))[0]
    height = struct.unpack("<I", f.read(4))[0]
    fps_num = struct.unpack("<I", f.read(4))[0]
    fps_den = struct.unpack("<I", f.read(4))[0]
    duration_ms = struct.unpack("<Q", f.read(8))[0]
    original_size = struct.unpack("<Q", f.read(8))[0]
    encrypted_size = struct.unpack("<Q", f.read(8))[0]
    content_hash = f.read(32)

    # Read title
    title_length = struct.unpack("<H", f.read(2))[0]
    title = f.read(title_length).decode("utf-8")

    # Read chunk index offset
    chunk_index_offset = struct.unpack("<I", f.read(4))[0]

    header = SvfHeader(
        version=version,
        video_id=video_id,
        tenant_id=tenant_id,
        encryption_salt=encryption_salt,
        encryption_nonce=encryption_nonce,
        chunk_size=chunk_size,
        chunk_count=chunk_count,
        quality=quality,
        codec=codec,
        width=width,
        height=height,
        fps_num=fps_num,
        fps_den=fps_den,
        duration_ms=duration_ms,
        original_size=original_size,
        encrypted_size=encrypted_size,
        content_hash=content_hash,
        title=title,
    )

    # Read chunk index table
    f.seek(chunk_index_offset)
    index_entries = []
    for i in range(chunk_count):
        offset = struct.unpack("<Q", f.read(8))[0]
        enc_size = struct.unpack("<I", f.read(4))[0]
        chunk_hash = f.read(32)
        index_entries.append(ChunkIndexEntry(offset=offset, encrypted_size=enc_size, hash=chunk_hash))

    return header, index_entries


def decrypt_chunk(key: bytes, base_nonce: bytes, chunk_index: int, encrypted_data: bytes) -> bytes:
    """Decrypt a single chunk with AES-256-CTR."""
    nonce = _derive_chunk_nonce(base_nonce, chunk_index)
    cipher = Cipher(algorithms.AES(key), modes.CTR(nonce))
    decryptor = cipher.decryptor()
    return decryptor.update(encrypted_data) + decryptor.finalize()


@click.command()
@click.argument("svf_file", type=click.Path(exists=True))
@click.option("--master-key", required=True, help="Hex-encoded 32-byte master key")
@click.option("--save-decrypted", default=None, help="Save decrypted video to this path")
def verify(svf_file, master_key, save_decrypted):
    """Verify an .svf file can be correctly decrypted."""
    svf_path = Path(svf_file)
    master_key_bytes = bytes.fromhex(master_key)

    click.echo(f"Verifying: {svf_path}")
    click.echo(f"File size: {svf_path.stat().st_size / 1048576:.1f} MB")
    click.echo()

    with open(svf_path, "rb") as f:
        # Step 1: Parse header
        click.echo("[1/5] Parsing header...")
        header, index_entries = parse_svf_header(f)

        quality_label = QUALITY_LABELS.get(header.quality, "unknown")
        click.echo(f"  Title: {header.title}")
        click.echo(f"  Video ID: {header.video_id.hex()}")
        click.echo(f"  Tenant ID: {header.tenant_id.hex()}")
        click.echo(f"  Quality: {quality_label} ({header.width}x{header.height})")
        click.echo(f"  Duration: {header.duration_ms}ms")
        click.echo(f"  Chunk size: {header.chunk_size / 1024:.0f} KB")
        click.echo(f"  Chunk count: {header.chunk_count}")
        click.echo(f"  Original size: {header.original_size / 1048576:.1f} MB")
        click.echo(f"  Encrypted size: {header.encrypted_size / 1048576:.1f} MB")
        click.echo()

        # Step 2: Derive key
        click.echo("[2/5] Deriving decryption key...")
        key = derive_video_key(
            master_key_bytes,
            header.encryption_salt,
            header.video_id,
            header.tenant_id,
            header.quality,
        )
        click.echo(f"  Derived key: {key[:4].hex()}...{key[-4:].hex()}")
        click.echo()

        # Step 3: Verify chunk hashes and decrypt
        click.echo("[3/5] Verifying and decrypting chunks...")
        decrypted_data = bytearray()
        hash_failures = 0

        for i, entry in enumerate(index_entries):
            # Read encrypted chunk
            f.seek(entry.offset)
            encrypted_chunk = f.read(entry.encrypted_size)

            # Verify chunk hash
            actual_hash = hashlib.sha256(encrypted_chunk).digest()
            if actual_hash != entry.hash:
                click.echo(f"  FAIL: Chunk {i} hash mismatch!")
                click.echo(f"    Expected: {entry.hash.hex()[:16]}...")
                click.echo(f"    Got:      {actual_hash.hex()[:16]}...")
                hash_failures += 1
                continue

            # Decrypt
            decrypted = decrypt_chunk(key, header.encryption_nonce, i, encrypted_chunk)
            decrypted_data.extend(decrypted)

            status = "OK" if len(encrypted_chunk) == entry.encrypted_size else "SIZE MISMATCH"
            click.echo(f"  Chunk {i}: {len(encrypted_chunk)} bytes -> {len(decrypted)} bytes [{status}]")

        if hash_failures > 0:
            click.echo(f"\n  FAILED: {hash_failures} chunk(s) had hash mismatches!")
            sys.exit(1)
        click.echo()

        # Step 4: Verify content hash
        click.echo("[4/5] Verifying content integrity...")
        actual_content_hash = hashlib.sha256(decrypted_data).digest()
        if actual_content_hash == header.content_hash:
            click.echo("  PASS: Decrypted content SHA-256 matches original!")
        else:
            click.echo("  FAIL: Content hash mismatch!")
            click.echo(f"    Expected: {header.content_hash.hex()[:32]}...")
            click.echo(f"    Got:      {actual_content_hash.hex()[:32]}...")
            sys.exit(1)
        click.echo()

        # Step 5: Verify file footer
        click.echo("[5/5] Verifying file footer...")
        # The footer is at the very end: 32 bytes hash + 4 bytes magic
        f.seek(-36, 2)  # 36 bytes from end
        file_hash = f.read(32)
        end_magic = f.read(4)

        if end_magic != SVF_MAGIC_END:
            click.echo(f"  FAIL: End magic mismatch: {end_magic.hex()}")
            sys.exit(1)
        click.echo("  PASS: End magic 'END!' found")

        # Verify file hash (hash of everything before the footer)
        f.seek(0)
        file_content = f.read(f.seek(-36, 2))
        f.seek(0)
        content_before_footer = f.read(svf_path.stat().st_size - 36)
        expected_file_hash = hashlib.sha256(content_before_footer).digest()

        if file_hash == expected_file_hash:
            click.echo("  PASS: File integrity hash matches!")
        else:
            click.echo("  FAIL: File integrity hash mismatch!")
            sys.exit(1)
        click.echo()

    # Save decrypted file if requested
    if save_decrypted:
        out_path = Path(save_decrypted)
        with open(out_path, "wb") as f:
            f.write(decrypted_data)
        click.echo(f"Saved decrypted video: {out_path} ({len(decrypted_data) / 1048576:.1f} MB)")
        click.echo("You can verify it plays with: ffplay " + str(out_path))
        click.echo()

    click.echo("=== ALL CHECKS PASSED ===")
    click.echo(f"The .svf file is valid and can be correctly decrypted.")


if __name__ == "__main__":
    verify()
