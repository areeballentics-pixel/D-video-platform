use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Authentication error: {0}")]
    Auth(String),

    #[error("API error: {0}")]
    Api(String),

    #[error("Encryption error: {0}")]
    Encryption(String),

    #[error("Keychain error: {0}")]
    Keychain(String),

    #[error("Invalid input: {0}")]
    Validation(String),

    #[error("Job error: {0}")]
    Job(String),

    #[error(transparent)]
    SvfCore(#[from] svf_core::SvfCoreError),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

// Tauri command return errors must be Serialize. We surface the Display string
// to React — internal Rust details stay out of the UI.
impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
