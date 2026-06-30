// watermark.rs — Dynamic watermark data generation
//
// Generates watermark text (user email + timestamp) and random positions.
// A background task emits Tauri events every 5-10 seconds with new positions.
// The React frontend renders this as a semi-transparent CSS overlay.

use chrono::Utc;
use rand::Rng;
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::watch;

/// Watermark data sent to the frontend via Tauri events
#[derive(Debug, Clone, Serialize)]
pub struct WatermarkData {
    /// Text to display (e.g., "user@email.com | 2026-04-06 14:32")
    pub text: String,
    /// X position as fraction 0.0 - 1.0 (from left edge)
    pub x: f64,
    /// Y position as fraction 0.0 - 1.0 (from top edge)
    pub y: f64,
    /// Opacity (0.16 - 0.26 — visible enough to deter + survive camera capture)
    pub opacity: f64,
    /// Rotation in degrees (-15 to +15)
    pub rotation: f64,
}

/// Generate a new watermark data point with random position.
fn generate_watermark(user_email: &str) -> WatermarkData {
    let mut rng = rand::thread_rng();

    let timestamp = Utc::now().format("%Y-%m-%d %H:%M").to_string();

    WatermarkData {
        text: format!("{} | {}", user_email, timestamp),
        // Keep within safe margins (10%-80%) so text doesn't get cut off
        x: rng.gen_range(0.10..0.70),
        y: rng.gen_range(0.10..0.80),
        // QA SP-011: 0.03-0.07 was effectively invisible (compounded by the
        // overlay's color alpha). Raise to a forensically visible band.
        opacity: rng.gen_range(0.16..0.26),
        rotation: rng.gen_range(-12.0..12.0),
    }
}

/// Background task that emits watermark position updates.
pub struct WatermarkRotator {
    stop_tx: watch::Sender<bool>,
}

impl WatermarkRotator {
    /// Start emitting "watermark-update" events every 5-10 seconds.
    pub fn start(app_handle: tauri::AppHandle, user_email: String) -> Self {
        let (stop_tx, mut stop_rx) = watch::channel(false);
        let email_for_log = user_email.clone();

        tokio::spawn(async move {
            // Emit initial watermark immediately
            let data = generate_watermark(&user_email);
            let _ = app_handle.emit("watermark-update", &data);

            loop {
                // Generate random delay outside the select! to avoid Send issues
                // rand::thread_rng() is not Send, so we use it briefly and drop it
                let delay_secs = {
                    let mut rng = rand::thread_rng();
                    rng.gen_range(5u64..=10u64)
                };
                let delay = std::time::Duration::from_secs(delay_secs);

                tokio::select! {
                    _ = tokio::time::sleep(delay) => {
                        let data = generate_watermark(&user_email);
                        let _ = app_handle.emit("watermark-update", &data);
                    }
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            log::info!("Watermark rotator stopped");
                            break;
                        }
                    }
                }
            }
        });

        log::info!("Watermark rotator started for {}", email_for_log);
        WatermarkRotator { stop_tx }
    }

    pub fn stop(&self) {
        let _ = self.stop_tx.send(true);
    }
}

impl Drop for WatermarkRotator {
    fn drop(&mut self) {
        self.stop();
    }
}
