// errors.rs — Slim error type for svf-core.
//
// This crate intentionally does NOT define application-level errors
// (License, Network, Security, etc.) — those belong in the consuming app.
// Application crates (player, encryptor, mobile JNI) wrap SvfCoreError
// in their own error type via `#[from]`.

use thiserror::Error;

#[derive(Error, Debug)]
pub enum SvfCoreError {
    #[error("SVF format error: {0}")]
    SvfParse(String),

    #[error("Cryptography error: {0}")]
    Crypto(String),

    #[error("Device error: {0}")]
    Device(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}
