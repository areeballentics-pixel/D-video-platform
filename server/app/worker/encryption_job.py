"""Video encryption job — runs as an arq background worker.

Pipeline: raw video → FFmpeg transcode (480p/720p/1080p) → AES-256-CTR encrypt → .svf package

Each step updates the job status in Redis so the dashboard can show real-time progress.
"""

import hashlib
import json
import os
import subprocess
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from arq import ArqRedis
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# ─── Quality presets ───
# CRF (Constant Rate Factor): lower = better quality & bigger file, higher = smaller file.
# These values produce good quality at reasonable file sizes:
#   480p CRF 28 → ~50-100 MB/hour (SD streaming quality)
#   720p CRF 26 → ~150-300 MB/hour (HD streaming quality)
#   1080p CRF 24 → ~300-600 MB/hour (Full HD, similar to YouTube)
QUALITY_PRESETS = {
    "480p": {"width": 854, "height": 480, "crf": 28},
    "720p": {"width": 1280, "height": 720, "crf": 26},
    "1080p": {"width": 1920, "height": 1080, "crf": 24},
}

QUALITY_MAP = {"480p": 0, "720p": 1, "1080p": 2}
CHUNK_SIZE = 1_048_576  # 1 MiB

# ─── SVF format constants ───
SVF_MAGIC = b"\x53\x56\x46\x01"
SVF_MAGIC_END = b"\x45\x4E\x44\x21"

# Paths
UPLOAD_DIR = Path(__file__).parent.parent.parent / "uploads"
ENCRYPTED_DIR = Path(__file__).parent.parent.parent / "encrypted"


async def update_status(redis: ArqRedis, job_id: str, status: str, progress: int = 0, detail: str = ""):
    """Update job status in Redis for real-time dashboard polling."""
    data = json.dumps({
        "status": status,
        "progress": progress,
        "detail": detail,
    })
    await redis.set(f"job:{job_id}:status", data, ex=86400)  # expire after 24h


async def encrypt_video_job(ctx: dict, job_id: str, video_id: str, tenant_id: str,
                            title: str, input_filename: str, qualities: list[str],
                            master_key_hex: str):
    """
    Main encryption job. Called by arq worker.

    Args:
        job_id: Unique job ID for status tracking
        video_id: UUID for the video
        tenant_id: UUID of the tenant
        title: Video title
        input_filename: Filename in uploads/ directory
        qualities: List of quality levels to produce
        master_key_hex: Hex-encoded 32-byte tenant master key
    """
    redis: ArqRedis = ctx["redis"]
    input_path = UPLOAD_DIR / input_filename
    ENCRYPTED_DIR.mkdir(parents=True, exist_ok=True)

    master_key = bytes.fromhex(master_key_hex)
    vid = uuid.UUID(video_id)
    tid = uuid.UUID(tenant_id)

    results = {}

    try:
        await update_status(redis, job_id, "probing", 5, "Analyzing video...")

        # Probe the source video
        probe_cmd = [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", str(input_path),
        ]
        probe_result = subprocess.run(probe_cmd, capture_output=True, text=True, check=True)
        probe_data = json.loads(probe_result.stdout)
        video_stream = next(s for s in probe_data["streams"] if s["codec_type"] == "video")
        duration_ms = int(float(probe_data["format"].get("duration", 0)) * 1000)

        total_qualities = len(qualities)

        # Generate ONE salt and nonce for all qualities of this video.
        # The HKDF 'info' parameter includes quality level, so each quality
        # still gets a unique key even with the same salt.
        encryption_salt = os.urandom(32)
        encryption_nonce = os.urandom(16)

        for qi, quality in enumerate(qualities):
            if quality not in QUALITY_PRESETS:
                continue

            preset = QUALITY_PRESETS[quality]
            quality_int = QUALITY_MAP[quality]
            base_progress = 10 + (qi * 80 // total_qualities)

            # ── Step 1: Transcode ──
            # Using "veryfast" preset for speed. On a production server, you could
            # use "fast" or "medium" if you prefer quality over speed.
            # FFmpeg threading is automatic — it uses all available CPU cores.
            await update_status(redis, job_id, "transcoding", base_progress,
                                f"Transcoding {quality}...")

            with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
                transcoded_path = Path(tmp.name)

            ffmpeg_cmd = [
                "ffmpeg", "-y",
                "-threads", "0",  # auto-detect CPU cores
                "-i", str(input_path),
                "-vf", f"scale={preset['width']}:{preset['height']}",
                "-c:v", "libx264",
                "-preset", "fast",  # good balance of speed and file size
                "-crf", str(preset["crf"]),
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart",
                "-f", "mp4",
                str(transcoded_path),
            ]
            subprocess.run(ffmpeg_cmd, check=True, capture_output=True)

            transcoded_size = transcoded_path.stat().st_size

            # Re-probe transcoded file for accurate dimensions
            probe2 = subprocess.run(
                ["ffprobe", "-v", "quiet", "-print_format", "json",
                 "-show_streams", str(transcoded_path)],
                capture_output=True, text=True, check=True,
            )
            probe2_data = json.loads(probe2.stdout)
            vs2 = next(s for s in probe2_data["streams"] if s["codec_type"] == "video")
            fps_parts = vs2.get("r_frame_rate", "30/1").split("/")
            fps_num = int(fps_parts[0])
            fps_den = int(fps_parts[1]) if len(fps_parts) > 1 else 1

            # ── Step 2: Read and chunk ──
            with open(transcoded_path, "rb") as f:
                raw_data = f.read()

            content_hash = hashlib.sha256(raw_data).digest()
            chunks = [raw_data[i:i + CHUNK_SIZE] for i in range(0, len(raw_data), CHUNK_SIZE)]

            # ── Step 3: Encrypt ──
            await update_status(redis, job_id, "encrypting", base_progress + 20,
                                f"Encrypting {quality} ({len(chunks)} chunks)...")

            # HKDF key derivation (salt/nonce shared across qualities, quality_int makes each key unique)
            info = vid.bytes + tid.bytes + quality_int.to_bytes(2, "little")
            hkdf = HKDF(algorithm=SHA256(), length=32, salt=encryption_salt, info=info)
            key = hkdf.derive(master_key)

            # Multi-threaded chunk encryption
            def encrypt_chunk(args):
                idx, chunk_data = args
                index_bytes = idx.to_bytes(16, "little")
                nonce = bytes(a ^ b for a, b in zip(encryption_nonce, index_bytes))
                cipher = Cipher(algorithms.AES(key), modes.CTR(nonce))
                enc = cipher.encryptor()
                ct = enc.update(chunk_data) + enc.finalize()
                return idx, ct, hashlib.sha256(ct).digest()

            with ThreadPoolExecutor(max_workers=min(os.cpu_count() or 4, len(chunks), 8)) as pool:
                encrypted_chunks = list(pool.map(encrypt_chunk, enumerate(chunks)))
            encrypted_chunks.sort(key=lambda x: x[0])

            encrypted_size = sum(len(c[1]) for c in encrypted_chunks)

            # ── Step 4: Package .svf ──
            await update_status(redis, job_id, "packaging", base_progress + 35,
                                f"Packaging {quality} .svf...")

            import struct
            svf_filename = f"{video_id}_{quality}.svf"
            svf_path = ENCRYPTED_DIR / svf_filename

            # Build header
            fixed_header = struct.pack(
                "<4sHH16s16s32s16sIIHHIIIIQQQ32s",
                SVF_MAGIC, 1, 0,
                vid.bytes, tid.bytes,
                encryption_salt, encryption_nonce,
                CHUNK_SIZE, len(chunks),
                quality_int, 0,  # codec = H.264
                int(vs2["width"]), int(vs2["height"]),
                fps_num, fps_den,
                duration_ms, transcoded_size, encrypted_size,
                content_hash,
            )

            title_bytes = title.encode("utf-8")[:512]
            title_data = struct.pack("<H", len(title_bytes)) + title_bytes

            header_size = len(fixed_header) + len(title_data) + 4
            chunk_index_size = 44 * len(chunks)  # 8 + 4 + 32 per entry
            data_offset = header_size + chunk_index_size

            # Build chunk index
            current_offset = data_offset
            index_data = b""
            for idx, ct, ct_hash in encrypted_chunks:
                index_data += struct.pack("<QI32s", current_offset, len(ct), ct_hash)
                current_offset += len(ct)

            # Write file with running hash
            hasher = hashlib.sha256()

            def write_and_hash(f, data):
                f.write(data)
                hasher.update(data)

            with open(svf_path, "wb") as f:
                write_and_hash(f, fixed_header)
                write_and_hash(f, title_data)
                write_and_hash(f, struct.pack("<I", header_size))
                write_and_hash(f, index_data)
                for idx, ct, ct_hash in encrypted_chunks:
                    write_and_hash(f, ct)
                file_hash = hasher.digest()
                f.write(file_hash)
                f.write(SVF_MAGIC_END)

            # Clean up transcoded file
            transcoded_path.unlink(missing_ok=True)

            results[quality] = {
                "filename": svf_filename,
                "size": svf_path.stat().st_size,
                "encryption_salt": encryption_salt.hex(),
                "encryption_nonce": encryption_nonce.hex(),
            }

        # ── Step 5: Register in database automatically ──
        await update_status(redis, job_id, "registering", 95, "Saving to database...")

        # Direct database registration — no manual "Register" button needed
        from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
        from sqlalchemy.orm import sessionmaker as async_sessionmaker
        from app.config import settings
        from app.models.video import Video
        import sqlalchemy

        db_engine = create_async_engine(settings.DATABASE_URL)
        async_session = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)

        async with async_session() as session:
            # Check if video already exists
            existing = await session.execute(
                sqlalchemy.select(Video).where(Video.id == vid)
            )
            if not existing.scalar_one_or_none():
                video = Video(
                    id=vid,
                    tenant_id=tid,
                    title=title,
                    description="",
                    qualities=list(results.keys()),
                    encryption_salt=encryption_salt,
                    encryption_nonce=encryption_nonce,
                    duration_ms=duration_ms,
                )
                session.add(video)
                await session.commit()

        await db_engine.dispose()

        # Also store result in Redis for the dashboard to show details
        await redis.set(
            f"job:{job_id}:result",
            json.dumps({
                "video_id": video_id,
                "tenant_id": tenant_id,
                "title": title,
                "duration_ms": duration_ms,
                "qualities": results,
            }),
            ex=86400,
        )

        # Clean up uploaded file
        input_path.unlink(missing_ok=True)

        await update_status(redis, job_id, "completed", 100, "Done! Video is ready for playback.")
        return {"status": "completed", "qualities": list(results.keys())}

    except Exception as e:
        await update_status(redis, job_id, "failed", 0, str(e))
        raise
