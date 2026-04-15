"""FFmpeg video transcoding — converts source videos to H.264 at multiple qualities."""

import json
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

# Quality presets for transcoding
QUALITY_PRESETS = {
    "480p": {"width": 854, "height": 480, "bitrate": "1000k", "crf": 23},
    "720p": {"width": 1280, "height": 720, "bitrate": "2500k", "crf": 22},
    "1080p": {"width": 1920, "height": 1080, "bitrate": "5000k", "crf": 21},
}


@dataclass
class VideoInfo:
    """Metadata extracted from source video via ffprobe."""

    width: int
    height: int
    duration_ms: int
    fps_num: int
    fps_den: int
    file_size: int


def probe_video(input_path: Path) -> VideoInfo:
    """Extract video metadata using ffprobe."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        str(input_path),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    data = json.loads(result.stdout)

    # Find the video stream
    video_stream = next(s for s in data["streams"] if s["codec_type"] == "video")

    # Parse frame rate (e.g., "30000/1001" or "30/1")
    fps_parts = video_stream.get("r_frame_rate", "30/1").split("/")
    fps_num = int(fps_parts[0])
    fps_den = int(fps_parts[1]) if len(fps_parts) > 1 else 1

    duration_s = float(data["format"].get("duration", 0))

    return VideoInfo(
        width=int(video_stream["width"]),
        height=int(video_stream["height"]),
        duration_ms=int(duration_s * 1000),
        fps_num=fps_num,
        fps_den=fps_den,
        file_size=int(data["format"].get("size", 0)),
    )


def transcode(
    input_path: Path,
    quality: str,
    output_dir: Path | None = None,
) -> Path:
    """
    Transcode a video to a specific quality preset.

    Uses +faststart to move the moov atom to the beginning (critical for
    the embedded HTTP server to start playback without seeking to end).

    Args:
        input_path: Path to source video
        quality: One of "480p", "720p", "1080p"
        output_dir: Directory for output (default: system temp dir)

    Returns:
        Path to the transcoded MP4 file
    """
    preset = QUALITY_PRESETS[quality]

    if output_dir is None:
        output_dir = Path(tempfile.mkdtemp(prefix="svp_transcode_"))
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / f"transcoded_{quality}.mp4"

    cmd = [
        "ffmpeg",
        "-y",  # Overwrite output
        "-i", str(input_path),
        "-vf", f"scale={preset['width']}:{preset['height']}",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", str(preset["crf"]),
        "-maxrate", preset["bitrate"],
        "-bufsize", str(int(preset["bitrate"].replace("k", "")) * 2) + "k",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        "-f", "mp4",
        str(output_path),
    ]

    subprocess.run(cmd, check=True, capture_output=True)
    return output_path
