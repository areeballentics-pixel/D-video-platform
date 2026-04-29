// svf-core — Shared SVF format I/O, AES-CTR crypto, and device fingerprinting.
//
// Compiled into:
//   - player/src-tauri (desktop player)
//   - encryptor/src-tauri (institute-side desktop encryptor)
//   - mobile JNI/FFI shims (Android, iOS) — added in tasks #9 and #10
//
// The crate is intentionally small and platform-portable. Windows-specific
// hardware-fingerprint code is cfg-gated; other platforms fall back to a
// hostname+OS hash until their native fingerprint sources are wired up.

pub mod crypto;
pub mod device;
pub mod errors;
pub mod svf;

// Convenience re-exports so consumers can write `use svf_core::SecureKey`
// instead of `use svf_core::crypto::SecureKey`.
pub use crypto::{decrypt_chunk, encrypt_chunk, SecureKey};
pub use device::{collect_fingerprint, DeviceInfo};
pub use errors::SvfCoreError;
pub use svf::{
    ChunkIndexEntry, Quality, SvfFile, SvfHeader, SvfInfo, SvfWriter, SvfWriterParams,
    SVF_MAGIC, SVF_MAGIC_END, SVF_VERSION,
};
