"""CLI interface for the SVP encryption tool.

Usage:
    python -m encrypt.cli encrypt --input video.mp4 --output ./out --title "Lecture 1" \\
        --video-id <uuid> --tenant-id <uuid> --master-key <hex> --qualities 480p,720p,1080p
"""

import hashlib
import os
import time
import uuid
from pathlib import Path

import click
from tqdm import tqdm

from .encryptor import encrypt_chunks
from .key_manager import derive_video_key
from .packager import package_svf
from .svf_format import CODEC_H264, DEFAULT_CHUNK_SIZE, QUALITY_MAP, SvfHeader
from .transcoder import probe_video, transcode


@click.group()
def cli():
    """Secure Video Player - Encryption Tool"""
    pass


@cli.command()
@click.option("--input", "input_path", required=True, type=click.Path(exists=True), help="Source video file")
@click.option("--output", "output_dir", required=True, type=click.Path(), help="Output directory for .svf files")
@click.option("--title", required=True, help="Video title (stored in .svf metadata)")
@click.option("--video-id", default=None, help="UUID for this video (auto-generated if not provided)")
@click.option("--tenant-id", required=True, help="Tenant UUID")
@click.option("--master-key", required=True, help="Hex-encoded 32-byte master key")
@click.option("--qualities", default="480p,720p,1080p", help="Comma-separated quality levels")
@click.option("--chunk-size", default=DEFAULT_CHUNK_SIZE, type=int, help="Chunk size in bytes (default: 1 MiB)")
def encrypt(input_path, output_dir, title, video_id, tenant_id, master_key, qualities, chunk_size):
    """Encrypt a video file into .svf format."""
    total_start = time.time()
    input_path = Path(input_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Parse arguments
    vid = uuid.UUID(video_id) if video_id else uuid.uuid4()
    tid = uuid.UUID(tenant_id)
    master_key_bytes = bytes.fromhex(master_key)
    quality_list = [q.strip() for q in qualities.split(",")]

    click.echo(f"Video ID:  {vid}")
    click.echo(f"Tenant ID: {tid}")
    click.echo(f"Input:     {input_path} ({input_path.stat().st_size / 1_048_576:.1f} MB)")
    click.echo(f"Qualities: {quality_list}")
    click.echo()

    # Probe source video
    click.echo("Probing source video...")
    info = probe_video(input_path)
    click.echo(f"  {info.width}x{info.height} | {info.duration_ms / 1000:.1f}s | {info.fps_num}/{info.fps_den} fps")
    click.echo()

    results = []

    for qi, quality in enumerate(quality_list, 1):
        if quality not in QUALITY_MAP:
            click.echo(f"Unknown quality: {quality}, skipping")
            continue

        click.echo(f"[{qi}/{len(quality_list)}] Processing {quality}")
        quality_start = time.time()

        # Step 1: Transcode
        click.echo("  Transcoding...", nl=False)
        t0 = time.time()
        transcoded_path = transcode(input_path, quality)
        transcoded_size = transcoded_path.stat().st_size
        click.echo(f" {transcoded_size / 1_048_576:.1f} MB ({time.time() - t0:.1f}s)")

        # Step 2: Read and split into chunks
        with open(transcoded_path, "rb") as f:
            raw_data = f.read()

        content_hash = hashlib.sha256(raw_data).digest()
        chunks = [raw_data[i:i + chunk_size] for i in range(0, len(raw_data), chunk_size)]

        # Step 3: Generate encryption parameters
        encryption_salt = os.urandom(32)
        encryption_nonce = os.urandom(16)

        # Step 4: Derive key
        quality_int = QUALITY_MAP[quality]
        key = derive_video_key(master_key_bytes, encryption_salt, vid.bytes, tid.bytes, quality_int)

        # Step 5: Encrypt chunks (multi-threaded) with progress bar
        click.echo(f"  Encrypting {len(chunks)} chunks...", nl=False)
        t0 = time.time()
        encrypted = encrypt_chunks(key, encryption_nonce, chunks)
        encrypt_time = time.time() - t0
        encrypted_size = sum(len(c.data) for c in encrypted)
        speed = (encrypted_size / 1_048_576) / encrypt_time if encrypt_time > 0 else float("inf")
        click.echo(f" {encrypted_size / 1_048_576:.1f} MB ({encrypt_time:.2f}s, {speed:.0f} MB/s)")

        # Step 6: Get video info from transcoded file
        transcoded_info = probe_video(transcoded_path)

        # Step 7: Build header
        header = SvfHeader(
            version=1,
            video_id=vid.bytes,
            tenant_id=tid.bytes,
            encryption_salt=encryption_salt,
            encryption_nonce=encryption_nonce,
            chunk_size=chunk_size,
            chunk_count=len(chunks),
            quality=quality_int,
            codec=CODEC_H264,
            width=transcoded_info.width,
            height=transcoded_info.height,
            fps_num=transcoded_info.fps_num,
            fps_den=transcoded_info.fps_den,
            duration_ms=transcoded_info.duration_ms,
            original_size=transcoded_size,
            encrypted_size=encrypted_size,
            content_hash=content_hash,
            title=title,
        )

        # Step 8: Package .svf file
        svf_filename = f"{vid}_{quality}.svf"
        svf_path = output_dir / svf_filename
        click.echo("  Packaging...", nl=False)
        t0 = time.time()
        package_svf(header, encrypted, svf_path)
        click.echo(f" ({time.time() - t0:.2f}s)")

        final_size = svf_path.stat().st_size
        quality_elapsed = time.time() - quality_start
        click.echo(f"  -> {svf_path.name} ({final_size / 1_048_576:.1f} MB, total {quality_elapsed:.1f}s)")
        click.echo()

        results.append((quality, final_size, quality_elapsed, speed))

        # Clean up transcoded file
        transcoded_path.unlink(missing_ok=True)

    # Summary
    total_elapsed = time.time() - total_start
    click.echo("=== Encryption Summary ===")
    for quality, size, elapsed, speed in results:
        click.echo(f"  {quality:>5s}: {size / 1_048_576:>6.1f} MB | {elapsed:>5.1f}s | {speed:>6.0f} MB/s encrypt speed")
    click.echo(f"  Total time: {total_elapsed:.1f}s")
    click.echo()


@cli.command()
def genkey():
    """Generate a random 32-byte master key (hex-encoded)."""
    key = os.urandom(32)
    click.echo(f"Master key: {key.hex()}")
    click.echo("Store this securely. It is needed to decrypt all videos for this tenant.")


# Register verify command from verify.py
from .verify import verify
cli.add_command(verify)


if __name__ == "__main__":
    cli()
