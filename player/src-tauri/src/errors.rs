// errors.rs — Unified error type for the entire application
//
// In Rust, we use enums to represent different error cases.
// The `thiserror` crate auto-generates Display and Error trait impls
// from the #[error("...")] attributes.

use thiserror::Error;

/// AppError covers all error types that can occur in the player.
/// Each variant represents a different category of failure.
#[derive(Error, Debug)]
pub enum AppError {
    #[error("SVF format error: {0}")]
    SvfParse(String),

    #[error("Cryptography error: {0}")]
    Crypto(String),

    #[error("License error: {0}")]
    License(String),

    #[error("Device error: {0}")]
    Device(String),

    #[error("Security violation: {0}")]
    Security(String),

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error(transparent)]
    SvfCore(#[from] svf_core::SvfCoreError),
}

// Tauri commands must return errors that implement `serde::Serialize`.
// We serialize errors as their display string — the frontend sees a
// human-readable error message, not internal Rust error details.
impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
