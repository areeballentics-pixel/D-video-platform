// mp4_probe.rs — Read MP4 metadata (width, height, duration, fps) without
// shelling out to ffprobe. Uses the pure-Rust `mp4` crate.
//
// If the input isn't a recognizable MP4, returns "unknown" defaults — the
// encryption still proceeds; the player just shows the video without specific
// dimension labels.

use serde::Serialize;
use std::path::Path;

use crate::errors::AppError;


#[derive(Debug, Clone, Serialize)]
pub struct VideoMeta {
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
    pub fps_num: u32,
    pub fps_den: u32,
    /// Auto-detected quality bucket: "480p" | "720p" | "1080p" | "original"
    pub quality_label: String,
}


impl VideoMeta {
    pub fn unknown() -> Self {
        VideoMeta {
            width: 0,
            height: 0,
            duration_ms: 0,
            fps_num: 0,
            fps_den: 1,
            quality_label: "original".to_string(),
        }
    }
}


/// Pick the closest standard quality bucket given the height. The encryptor
/// labels each .svf with this so the dashboard + player can show consistent
/// quality choices. Anything outside the standard buckets is "original".
fn classify_quality(width: u32, height: u32) -> String {
    // Use height as the canonical dimension (some videos are vertical etc.).
    // 1080p ±15%, 720p ±15%, 480p ±15% — generous bands so 1280x720 lands as
    // 720p even if the source had non-square pixels.
    let h = height as f32;
    if (920.0..=1240.0).contains(&h) || (1900.0..=1940.0).contains(&(width as f32)) {
        "1080p".to_string()
    } else if (612.0..=828.0).contains(&h) || (1170.0..=1390.0).contains(&(width as f32)) {
        "720p".to_string()
    } else if (408.0..=552.0).contains(&h) || (770.0..=940.0).contains(&(width as f32)) {
        "480p".to_string()
    } else {
        "original".to_string()
    }
}


pub fn probe<P: AsRef<Path>>(path: P) -> Result<VideoMeta, AppError> {
    let file = std::fs::File::open(path.as_ref())?;
    let size = file.metadata()?.len();
    let reader = std::io::BufReader::new(file);

    let mp4 = match mp4::Mp4Reader::read_header(reader, size) {
        Ok(r) => r,
        Err(_) => return Ok(VideoMeta::unknown()),
    };

    let duration_ms = mp4.duration().as_millis() as u64;

    // Find the first video track.
    let video_track = mp4.tracks().values().find(|t| {
        matches!(
            t.track_type().ok(),
            Some(mp4::TrackType::Video)
        )
    });

    let Some(track) = video_track else {
        return Ok(VideoMeta {
            duration_ms,
            ..VideoMeta::unknown()
        });
    };

    let width = track.width() as u32;
    let height = track.height() as u32;

    // Frame rate: tracks expose framerate as a rational from sample timestamps.
    // The mp4 crate gives a single f64; convert to a tidy num/den.
    let fps = track.frame_rate();
    let (fps_num, fps_den) = if fps > 0.0 {
        // Heuristic: if fps is close to a multiple of 1/1001 (e.g., 23.976,
        // 29.97, 59.94), use the broadcast-standard rational. Otherwise
        // fall back to (round(fps*1000), 1000).
        if (fps - 23.976).abs() < 0.01 {
            (24000, 1001)
        } else if (fps - 29.97).abs() < 0.01 {
            (30000, 1001)
        } else if (fps - 59.94).abs() < 0.01 {
            (60000, 1001)
        } else {
            ((fps * 1000.0).round() as u32, 1000)
        }
    } else {
        (30, 1)
    };

    let quality_label = classify_quality(width, height);

    Ok(VideoMeta {
        width,
        height,
        duration_ms,
        fps_num,
        fps_den,
        quality_label,
    })
}


/// Hard up-front gate run BEFORE encryption begins. Unlike `probe()` (which
/// degrades to `VideoMeta::unknown()` so quality labelling never blocks a job),
/// this REJECTS inputs that aren't a recognizable video container (ENC-003) or
/// are corrupted MP4s with no parseable video track (ENC-004).
///
/// Strategy:
///   * Sniff the leading magic bytes against an allowlist of common video
///     containers (institutes upload mkv/webm/avi/etc., not just MP4).
///   * For the ISO-BMFF / MP4 family specifically, ALSO require the `mp4`
///     crate to parse a header AND find a video track — this catches a
///     hex-corrupted `.mp4` that still carries a valid `ftyp` box.
///   * Other containers can't be deep-validated without ffmpeg (out of scope),
///     so a magic match is accepted as sufficient.
pub fn validate_video_file<P: AsRef<Path>>(path: P) -> Result<(), AppError> {
    let path = path.as_ref();

    // Read up to the first 16 bytes — enough for every magic below.
    let mut file = std::fs::File::open(path)?;
    let mut magic = [0u8; 16];
    let n = read_up_to(&mut file, &mut magic)?;
    let head = &magic[..n];

    // ── Container magic allowlist ──────────────────────────────────────────
    // ISO-BMFF (MP4/MOV/M4V): bytes 4..8 == "ftyp"
    let is_iso_bmff = head.len() >= 8 && &head[4..8] == b"ftyp";
    // Matroska / WebM: EBML magic 1A 45 DF A3
    let is_matroska = head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]);
    // AVI: "RIFF" .... "AVI "
    let is_avi = head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"AVI ";
    // MPEG-TS: sync byte 0x47
    let is_mpegts = head.first() == Some(&0x47);
    // FLV: bytes 0..3 == "FLV"
    let is_flv = head.starts_with(b"FLV");
    // Ogg (Theora): bytes 0..4 == "OggS"
    let is_ogg = head.starts_with(b"OggS");
    // ASF / WMV: leading GUID 30 26 B2 75 8E 66 CF 11
    let is_asf = head.starts_with(&[0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11]);

    if is_iso_bmff {
        // Deep-validate the MP4 family: confirm a header parses and a real
        // video track exists (ENC-004 — corrupted but ftyp-tagged MP4).
        return validate_iso_bmff(path);
    }

    if is_matroska || is_avi || is_mpegts || is_flv || is_ogg || is_asf {
        return Ok(());
    }

    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string());
    Err(AppError::Validation(format!(
        "'{}' is not a valid video file. Please choose a video (MP4, MOV, MKV, WebM, AVI, etc.).",
        name
    )))
}


/// Deep validation for the ISO-BMFF / MP4 family: the file must parse via the
/// `mp4` crate AND contain at least one video track. A `.txt` renamed `.mp4`
/// won't have `ftyp` (so it's rejected by the magic check), while a truncated
/// or hex-corrupted real MP4 fails here.
fn validate_iso_bmff(path: &Path) -> Result<(), AppError> {
    let file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    let reader = std::io::BufReader::new(file);

    let mp4 = mp4::Mp4Reader::read_header(reader, size).map_err(|e| {
        AppError::Validation(format!(
            "this MP4 file appears to be corrupted and can't be read ({})",
            e
        ))
    })?;

    let has_video = mp4
        .tracks()
        .values()
        .any(|t| matches!(t.track_type().ok(), Some(mp4::TrackType::Video)));

    if !has_video {
        return Err(AppError::Validation(
            "this MP4 file has no video track — please choose a valid video file".into(),
        ));
    }
    Ok(())
}


/// Read up to `buf.len()` bytes, tolerating short reads, stopping at EOF.
/// Returns how many bytes were actually read (may be < buf.len() for tiny
/// files). Mirrors `pipeline::read_full_or_eof`.
fn read_up_to<R: std::io::Read>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_classification() {
        assert_eq!(classify_quality(1920, 1080), "1080p");
        assert_eq!(classify_quality(1280, 720), "720p");
        assert_eq!(classify_quality(854, 480), "480p");
        assert_eq!(classify_quality(640, 360), "original");
        assert_eq!(classify_quality(3840, 2160), "original");
    }

    #[test]
    fn missing_file_returns_unknown_or_error() {
        // Probing a non-existent path yields an IO error; we don't pretend.
        let r = probe("/no/such/file.mp4");
        assert!(r.is_err());
    }

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        use std::io::Write;
        let p = std::env::temp_dir().join(format!("svp-validate-{}-{}", std::process::id(), name));
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(bytes).unwrap();
        p
    }

    #[test]
    fn rejects_text_renamed_as_mp4() {
        // ENC-003: a .txt renamed .mp4 has no container magic.
        let p = write_temp("fake.mp4", b"this is just some plain text, not a video at all\n");
        let r = validate_video_file(&p);
        let _ = std::fs::remove_file(&p);
        assert!(r.is_err(), "plain text must be rejected");
    }

    #[test]
    fn rejects_ftyp_without_video_track() {
        // ENC-004: right ISO-BMFF magic but garbage body → no parseable video.
        let mut bytes = vec![0u8, 0, 0, 0x18];
        bytes.extend_from_slice(b"ftypmp42");
        bytes.extend_from_slice(&[0u8; 64]); // truncated/garbage rest
        let p = write_temp("corrupt.mp4", &bytes);
        let r = validate_video_file(&p);
        let _ = std::fs::remove_file(&p);
        assert!(r.is_err(), "corrupted ftyp-only MP4 must be rejected");
    }

    #[test]
    fn accepts_matroska_magic() {
        // Non-MP4 container: magic match alone is sufficient (no ffmpeg).
        let mut bytes = vec![0x1A, 0x45, 0xDF, 0xA3];
        bytes.extend_from_slice(&[0u8; 32]);
        let p = write_temp("clip.mkv", &bytes);
        let r = validate_video_file(&p);
        let _ = std::fs::remove_file(&p);
        assert!(r.is_ok(), "matroska magic must be accepted");
    }
}
