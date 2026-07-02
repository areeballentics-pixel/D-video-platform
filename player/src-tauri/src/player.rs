// player.rs — Video playback via a Tauri custom URI scheme protocol (`stream`)
//
// PREVIOUS DESIGN (removed): a localhost HTTP server bound to
// 127.0.0.1:<random-port>/video.mp4?token=<uuid> streamed the decrypted bytes,
// and the <video> element pointed at it. Because that URL lived in the
// webview's DOM and was a real TCP endpoint, it could be copied (right-click →
// "copy video address") and opened in any external browser — concurrently,
// across browser restarts, for as long as the player ran (QA SP-006/007/010/013).
//
// CURRENT DESIGN: we register a Tauri custom URI scheme ("stream") and serve the
// decrypted byte ranges from it. Custom schemes are handled INSIDE the webview
// process over IPC — there is NO TCP socket and NO port, so there is no URL an
// external browser can resolve. The <video src> is:
//   - Windows / Android (useHttpsScheme=false): http://stream.localhost/video.mp4
//   - macOS / Linux:                            stream://localhost/video.mp4
//
// Security:
// - No network-reachable endpoint exists at all (stronger than localhost-bind).
// - Decrypted bytes only exist in memory momentarily, per Range request.
// - The active playback is cleared on stop / navigation / logout, so the scheme
//   returns 404 once playback ends.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::http::{Request, Response, StatusCode};

use svf_core::{decrypt_chunk, SecureKey, SvfFile};

use crate::errors::AppError;

/// The custom scheme name. Keep in sync with the CSP `media-src` in
/// tauri.conf.json and with `stream_url()` below.
pub const STREAM_SCHEME: &str = "stream";

/// Info returned to the React frontend when playback starts.
#[derive(Debug, Clone, Serialize)]
pub struct PlaybackInfo {
    /// URL to set as the <video> element's src (custom-scheme, not http TCP).
    pub url: String,
    /// Canonical UUID of the video (from the .svf header) — used by the
    /// frontend to report watch heartbeats and to re-validate access.
    pub video_id: String,
    pub title: String,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub quality: String,
}

/// All state needed by the custom-protocol handler to decrypt-on-the-fly.
/// Uses a std Mutex (the handler is synchronous; no async lock is needed).
pub struct ActivePlayback {
    /// Unique per-playback token embedded in the stream URL. The WebView keys
    /// its media cache on the URL, so a FIXED url served across two different
    /// videos let it replay a previous video's cached byte ranges for a new
    /// video (wrong video / corruption, and it poisoned the earlier video too).
    /// A fresh token per playback gives each video a distinct url, and the
    /// handler 404s any request whose token isn't the active one.
    token: String,
    svf: Mutex<SvfFile>,
    key: SecureKey,
    original_size: u64,
    chunk_size: u64,
    chunk_count: usize,
    nonce: [u8; 16],
}

/// Shared slot held in AppState and read by the protocol handler. `None` when
/// nothing is playing → the scheme returns 404.
pub type PlaybackSlot = Arc<Mutex<Option<Arc<ActivePlayback>>>>;

/// Build the `<video src>` URL for the registered custom scheme on this platform.
pub fn stream_url(token: &str) -> String {
    // A unique `token` per playback makes each video's url distinct, so the
    // WebView can never serve a previous video's cached bytes for a new video.
    // Windows/Android with useHttpsScheme=false → http://<scheme>.localhost
    #[cfg(any(windows, target_os = "android"))]
    {
        format!("http://{}.localhost/{}.mp4", STREAM_SCHEME, token)
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        format!("{}://localhost/{}.mp4", STREAM_SCHEME, token)
    }
}

/// Open the .svf, derive playback metadata, and produce the shared ActivePlayback
/// plus the PlaybackInfo for the frontend.
pub fn prepare_playback(
    svf_path: &Path,
    key: SecureKey,
) -> Result<(Arc<ActivePlayback>, PlaybackInfo), AppError> {
    let svf = SvfFile::open(svf_path)?;
    let original_size = svf.header.original_size;
    let chunk_size = svf.header.chunk_size as u64;
    let nonce = svf.header.encryption_nonce;
    let chunk_count = svf.header.chunk_count as usize;
    let video_id = uuid::Uuid::from_bytes(svf.header.video_id).to_string();

    // Fresh random token per playback → unique stream url (WebView cache-bust).
    let token = uuid::Uuid::new_v4().simple().to_string();

    let info = PlaybackInfo {
        url: stream_url(&token),
        video_id,
        title: svf.header.title.clone(),
        duration_ms: svf.header.duration_ms,
        width: svf.header.width,
        height: svf.header.height,
        quality: svf.header.quality_label().to_string(),
    };

    let state = Arc::new(ActivePlayback {
        token,
        svf: Mutex::new(svf),
        key,
        original_size,
        chunk_size,
        chunk_count,
        nonce,
    });

    Ok((state, info))
}

/// Maximum bytes to return in a single response. The browser sends follow-up
/// Range requests for the rest. 2 MB keeps memory low and responses fast.
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

/// Custom-protocol handler: serve a decrypted byte range for the active playback.
/// Synchronous — decryption is CPU-bound and each response is capped at 2 MB.
pub fn serve_stream(slot: &PlaybackSlot, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let state = { slot.lock().unwrap().clone() };
    let Some(state) = state else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(b"No active playback".to_vec())
            .unwrap();
    };

    // Serve ONLY the currently active playback. A stale request from a previous
    // video's <video> element carries that video's (old) token in its url; it
    // must not receive this video's bytes — that's the "wrong video / corrupt"
    // failure. Mismatched token → 404, so the WebView can't cross-contaminate.
    let req_token = request
        .uri()
        .path()
        .trim_start_matches('/')
        .strip_suffix(".mp4")
        .unwrap_or("");
    if req_token != state.token {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(b"Stale playback token".to_vec())
            .unwrap();
    }

    if state.original_size == 0 {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(Vec::new())
            .unwrap();
    }

    let range_header = request
        .headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let (range_start, range_end) = parse_range_header(&range_header, state.original_size);

    match decrypt_range(&state, range_start, range_end) {
        Ok(data) => {
            let content_length = data.len();
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header("Content-Type", "video/mp4")
                .header("Accept-Ranges", "bytes")
                .header("Content-Length", content_length.to_string())
                .header(
                    "Content-Range",
                    format!(
                        "bytes {}-{}/{}",
                        range_start,
                        range_start + content_length as u64 - 1,
                        state.original_size
                    ),
                )
                // On Windows the page is http://tauri.localhost while media loads
                // from http://stream.localhost; keep media loads unblocked.
                .header("Access-Control-Allow-Origin", "*")
                .header("Cache-Control", "no-store")
                .body(data)
                .unwrap()
        }
        Err(_) => Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(b"Decryption error".to_vec())
            .unwrap(),
    }
}

// ─── Helper functions ───

fn parse_range_header(range: &Option<String>, total_size: u64) -> (u64, u64) {
    let max_end = total_size.saturating_sub(1);

    let Some(range_str) = range else {
        // No Range header — return first chunk only, not the entire file.
        return (0, MAX_RESPONSE_BYTES.min(max_end));
    };

    let range_str = range_str.trim();
    if !range_str.starts_with("bytes=") {
        return (0, MAX_RESPONSE_BYTES.min(max_end));
    }

    let range_spec = &range_str[6..]; // skip "bytes="
    let parts: Vec<&str> = range_spec.split('-').collect();

    // Clamp start into [0, max_end] so a past-EOF request (e.g. bytes=2000-3000
    // on a 1000-byte file) can't underflow / panic in decrypt_range.
    let start = parts
        .first()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0)
        .min(max_end);

    let end = parts
        .get(1)
        .and_then(|s| {
            if s.is_empty() {
                None
            } else {
                s.parse::<u64>().ok()
            }
        })
        .unwrap_or_else(|| (start + MAX_RESPONSE_BYTES - 1).min(max_end))
        .min(max_end)
        .max(start); // guarantee end >= start

    (start, end)
}

/// Decrypt the byte range [range_start, range_end] from the encrypted video.
fn decrypt_range(
    state: &ActivePlayback,
    range_start: u64,
    range_end: u64,
) -> Result<Vec<u8>, AppError> {
    let chunk_size = state.chunk_size;
    let first_chunk = (range_start / chunk_size) as usize;
    let last_chunk = (range_end / chunk_size).min(state.chunk_count as u64 - 1) as usize;

    let mut decrypted_buffer = Vec::new();
    let mut svf = state.svf.lock().unwrap();

    for chunk_idx in first_chunk..=last_chunk {
        let encrypted = svf.read_chunk(chunk_idx)?;
        let decrypted = decrypt_chunk(&state.key, &state.nonce, chunk_idx as u64, &encrypted)?;
        decrypted_buffer.extend_from_slice(&decrypted);
    }
    drop(svf);

    let buffer_start_offset = first_chunk as u64 * chunk_size;
    let slice_start = (range_start - buffer_start_offset) as usize;
    let slice_end = (range_end - buffer_start_offset + 1) as usize;
    let slice_end = slice_end.min(decrypted_buffer.len());

    Ok(decrypted_buffer[slice_start..slice_end].to_vec())
}

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_range_none() {
        let (start, end) = parse_range_header(&None, 1_000_000_000);
        assert_eq!(start, 0);
        assert!(end < 1_000_000_000);
        assert_eq!(end, MAX_RESPONSE_BYTES.min(1_000_000_000 - 1));
    }

    #[test]
    fn test_parse_range_open_end() {
        let (start, end) =
            parse_range_header(&Some("bytes=100-".to_string()), 1_000_000_000);
        assert_eq!(start, 100);
        assert_eq!(end, 100 + MAX_RESPONSE_BYTES - 1);
    }

    #[test]
    fn test_parse_range_closed() {
        let (start, end) =
            parse_range_header(&Some("bytes=100-200".to_string()), 1000);
        assert_eq!(start, 100);
        assert_eq!(end, 200);
    }

    #[test]
    fn test_parse_range_from_start() {
        let (start, end) =
            parse_range_header(&Some("bytes=0-".to_string()), 5000);
        assert_eq!(start, 0);
        assert_eq!(end, 4999);
    }

    #[test]
    fn test_parse_range_clamp() {
        let (start, end) =
            parse_range_header(&Some("bytes=900-2000".to_string()), 1000);
        assert_eq!(start, 900);
        assert_eq!(end, 999);
    }
}
