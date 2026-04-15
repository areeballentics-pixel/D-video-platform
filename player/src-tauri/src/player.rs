// player.rs — Video playback via embedded local HTTP server
//
// This is the core playback engine. When a user clicks "play" on an .svf file:
//
// 1. We parse the .svf file and derive the decryption key
// 2. We spawn a tiny HTTP server on 127.0.0.1 with a random port
// 3. We give the React frontend a URL: http://127.0.0.1:{port}/video.mp4?token={uuid}
// 4. The <video> element sends HTTP Range requests to this URL
// 5. For each Range request, we:
//    a. Figure out which encrypted chunks cover the requested byte range
//    b. Decrypt those chunks on-the-fly (in memory, never on disk)
//    c. Slice out the exact bytes requested
//    d. Return them with proper 206 Partial Content headers
// 6. When playback stops, we shut down the server and zero the key
//
// Security:
// - Server binds to 127.0.0.1 only (not 0.0.0.0)
// - Random ephemeral port (not predictable)
// - One-time UUID token per playback session
// - Decrypted bytes only exist in memory momentarily

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;
use warp::{Filter, Reply};

use crate::crypto::{decrypt_chunk, SecureKey};
use crate::errors::AppError;
use crate::svf::SvfFile;

/// Info returned to the React frontend when playback starts
#[derive(Debug, Clone, Serialize)]
pub struct PlaybackInfo {
    /// URL to set as the <video> element's src
    pub url: String,
    /// Video metadata for the UI
    pub title: String,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub quality: String,
}

/// The active video server — holds all state needed during playback
pub struct VideoServer {
    /// The port the server is listening on
    port: u16,
    /// Channel to send shutdown signal
    shutdown_tx: Option<oneshot::Sender<()>>,
    /// Path to the .svf file (for display purposes)
    svf_path: PathBuf,
}

/// Shared state accessible from warp request handlers.
/// Arc = thread-safe reference counting, Mutex = thread-safe interior mutability.
/// This is how multiple concurrent HTTP requests can access the same SvfFile and key.
struct PlaybackState {
    svf: Mutex<SvfFile>,
    key: SecureKey,
    #[allow(dead_code)]
    token: String,
}

impl VideoServer {
    /// Start a new video server for the given .svf file.
    ///
    /// This opens the file, derives the decryption key, spawns the HTTP server,
    /// and returns a VideoServer handle + PlaybackInfo for the frontend.
    pub async fn start(
        svf_path: &Path,
        key: SecureKey,
    ) -> Result<(Self, PlaybackInfo), AppError> {
        // Open and parse the .svf file
        let svf = SvfFile::open(svf_path)?;
        let _info = svf.header.to_info();
        let original_size = svf.header.original_size;
        let chunk_size = svf.header.chunk_size as u64;
        let nonce = svf.header.encryption_nonce;
        let chunk_count = svf.header.chunk_count as usize;

        let playback_info = PlaybackInfo {
            url: String::new(), // filled in below after we know the port
            title: svf.header.title.clone(),
            duration_ms: svf.header.duration_ms,
            width: svf.header.width,
            height: svf.header.height,
            quality: svf.header.quality_label().to_string(),
        };

        // Generate a one-time token for this playback session
        let token = Uuid::new_v4().to_string();

        // Create shared state
        let state = Arc::new(PlaybackState {
            svf: Mutex::new(svf),
            key,
            token: token.clone(),
        });

        // Build the warp route
        let state_filter = {
            let s = state.clone();
            warp::any().map(move || s.clone())
        };

        // Capture values for the closure
        let token_for_route = token.clone();

        let video_route = warp::get()
            .and(warp::path("video.mp4"))
            .and(warp::query::<std::collections::HashMap<String, String>>())
            .and(warp::header::optional::<String>("range"))
            .and(state_filter)
            .and_then(
                move |query: std::collections::HashMap<String, String>,
                      range_header: Option<String>,
                      state: Arc<PlaybackState>| {
                    let token_check = token_for_route.clone();
                    async move {
                        // Validate token
                        let req_token = query.get("token").cloned().unwrap_or_default();
                        if req_token != token_check {
                            return Ok::<_, warp::Rejection>(
                                warp::reply::with_status(
                                    warp::reply::Response::new(
                                        warp::hyper::Body::from("Forbidden"),
                                    ),
                                    warp::http::StatusCode::FORBIDDEN,
                                )
                                .into_response(),
                            );
                        }

                        // Parse Range header
                        let (range_start, range_end) =
                            parse_range_header(&range_header, original_size);

                        // Decrypt the requested byte range
                        let data = decrypt_range(
                            &state,
                            range_start,
                            range_end,
                            chunk_size,
                            chunk_count,
                            &nonce,
                        )
                        .await;

                        let data = match data {
                            Ok(d) => d,
                            Err(_) => {
                                return Ok(warp::reply::with_status(
                                    warp::reply::Response::new(
                                        warp::hyper::Body::from("Decryption error"),
                                    ),
                                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                                )
                                .into_response());
                            }
                        };

                        let content_length = data.len();

                        // Build response with proper headers
                        let response = warp::http::Response::builder()
                            .status(206)
                            .header("Content-Type", "video/mp4")
                            .header("Accept-Ranges", "bytes")
                            .header("Content-Length", content_length)
                            .header(
                                "Content-Range",
                                format!(
                                    "bytes {}-{}/{}",
                                    range_start,
                                    range_start + content_length as u64 - 1,
                                    original_size
                                ),
                            )
                            .header("Access-Control-Allow-Origin", "*")
                            .body(warp::hyper::Body::from(data))
                            .unwrap();

                        Ok(response.into_response())
                    }
                },
            );

        // CORS preflight support
        let cors_route = warp::options()
            .and(warp::path("video.mp4"))
            .map(|| {
                warp::http::Response::builder()
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Access-Control-Allow-Methods", "GET, OPTIONS")
                    .header("Access-Control-Allow-Headers", "Range")
                    .body(warp::hyper::Body::empty())
                    .unwrap()
            });

        let routes = video_route.or(cors_route);

        // Bind to 127.0.0.1 with port 0 (OS assigns a random available port)
        let addr: SocketAddr = ([127, 0, 0, 1], 0).into();

        // Create shutdown channel
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        // bind_with_graceful_shutdown returns (SocketAddr, impl Future)
        let (bound_addr, server) = warp::serve(routes)
            .bind_with_graceful_shutdown(addr, async {
                let _ = shutdown_rx.await;
            });
        let port = bound_addr.port();

        // Spawn the server in a background task
        tokio::spawn(server);

        let url = format!(
            "http://127.0.0.1:{}/video.mp4?token={}",
            port, token
        );

        let mut final_info = playback_info;
        final_info.url = url;

        let video_server = VideoServer {
            port,
            shutdown_tx: Some(shutdown_tx),
            svf_path: svf_path.to_path_buf(),
        };

        log::info!(
            "Video server started on port {} for {:?}",
            port,
            svf_path
        );

        Ok((video_server, final_info))
    }

    /// Stop the video server and clean up
    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
            log::info!("Video server stopped for {:?}", self.svf_path);
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for VideoServer {
    fn drop(&mut self) {
        self.stop();
    }
}

// ─── Helper functions ───

/// Parse the HTTP Range header into (start, end) byte positions.
///
/// Handles formats:
/// - "bytes=0-"       → (0, total - 1)
/// - "bytes=100-200"  → (100, 200)
/// - "bytes=100-"     → (100, total - 1)
/// - None / invalid   → (0, total - 1)
/// Maximum bytes to return in a single response.
/// The browser will send follow-up Range requests for the rest.
/// 2 MB keeps memory usage low and response time fast.
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

fn parse_range_header(range: &Option<String>, total_size: u64) -> (u64, u64) {
    let Some(range_str) = range else {
        // No Range header — return first chunk only, not entire file
        let end = MAX_RESPONSE_BYTES.min(total_size - 1);
        return (0, end);
    };

    let range_str = range_str.trim();
    if !range_str.starts_with("bytes=") {
        let end = MAX_RESPONSE_BYTES.min(total_size - 1);
        return (0, end);
    }

    let range_spec = &range_str[6..]; // skip "bytes="
    let parts: Vec<&str> = range_spec.split('-').collect();

    let start = parts
        .first()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let end = parts
        .get(1)
        .and_then(|s| {
            if s.is_empty() {
                None
            } else {
                s.parse::<u64>().ok()
            }
        })
        // If no end specified (open-ended range like "bytes=100-"),
        // return at most MAX_RESPONSE_BYTES from start
        .unwrap_or_else(|| (start + MAX_RESPONSE_BYTES - 1).min(total_size - 1))
        .min(total_size - 1);

    (start, end)
}

/// Decrypt the byte range [range_start, range_end] from the encrypted video.
///
/// This maps the requested byte range to encrypted chunks, decrypts only
/// the needed chunks, and slices out the exact bytes requested.
async fn decrypt_range(
    state: &PlaybackState,
    range_start: u64,
    range_end: u64,
    chunk_size: u64,
    chunk_count: usize,
    nonce: &[u8; 16],
) -> Result<Vec<u8>, AppError> {
    // Which chunks do we need to decrypt?
    let first_chunk = (range_start / chunk_size) as usize;
    let last_chunk = (range_end / chunk_size).min(chunk_count as u64 - 1) as usize;

    let mut decrypted_buffer = Vec::new();

    // Lock the SvfFile for reading (we need exclusive access because read_chunk seeks)
    let mut svf = state.svf.lock().await;

    for chunk_idx in first_chunk..=last_chunk {
        // Read the encrypted chunk from the .svf file
        let encrypted = svf.read_chunk(chunk_idx)?;

        // Decrypt it
        let decrypted = decrypt_chunk(&state.key, nonce, chunk_idx as u64, &encrypted)?;

        decrypted_buffer.extend_from_slice(&decrypted);
    }

    // Now slice out only the bytes that were actually requested.
    // The decrypted_buffer contains full chunks starting from first_chunk.
    // We need to trim the beginning and end to match the Range request.
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
        // Capped to MAX_RESPONSE_BYTES, not entire file
        assert!(end < 1_000_000_000);
        assert_eq!(end, MAX_RESPONSE_BYTES.min(1_000_000_000 - 1));
    }

    #[test]
    fn test_parse_range_open_end() {
        let (start, end) =
            parse_range_header(&Some("bytes=100-".to_string()), 1_000_000_000);
        assert_eq!(start, 100);
        assert_eq!(end, 100 + MAX_RESPONSE_BYTES - 1); // capped
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
        // Range extends past end of file — should be clamped
        let (start, end) =
            parse_range_header(&Some("bytes=900-2000".to_string()), 1000);
        assert_eq!(start, 900);
        assert_eq!(end, 999);
    }
}
