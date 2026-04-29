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
}
