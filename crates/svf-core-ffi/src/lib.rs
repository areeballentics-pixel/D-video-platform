// svf-core-ffi — Plain C ABI exposing svf-core to iOS Swift.
//
// All buffers are passed as `(ptr, len)` tuples. Decrypted output goes into
// caller-provided buffers (Swift allocates a Data, passes us a mutable
// pointer). Error reporting is via negative return codes; positive returns
// are always valid byte counts or handles.
//
// Memory management contract:
//   - svp_open(path) returns a handle (>0) or 0 on error
//   - svp_close(handle) frees the handle's resources
//   - svp_decrypt_chunk(...) writes into the caller's buffer (no allocation
//     on the Rust side that the caller has to free)

use std::collections::HashMap;
use std::ffi::CStr;
use std::os::raw::{c_char, c_int, c_long};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use svf_core::{decrypt_chunk, SecureKey, SvfFile};


static REGISTRY: Lazy<Mutex<HashMap<i64, SvfFile>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_HANDLE: Lazy<Mutex<i64>> = Lazy::new(|| Mutex::new(1));


fn next_handle() -> i64 {
    let mut g = NEXT_HANDLE.lock().unwrap();
    let h = *g;
    *g += 1;
    h
}


/// Open an .svf file by path. Returns a positive handle on success or 0 on
/// failure. The caller passes a UTF-8 null-terminated C string.
///
/// # Safety
/// `path` must point to a valid null-terminated UTF-8 string.
#[no_mangle]
pub unsafe extern "C" fn svp_open(path: *const c_char) -> i64 {
    if path.is_null() {
        return 0;
    }
    let cstr = CStr::from_ptr(path);
    let path_str = match cstr.to_str() {
        Ok(s) => s,
        Err(_) => return 0,
    };

    match SvfFile::open(path_str) {
        Ok(f) => {
            let h = next_handle();
            REGISTRY.lock().unwrap().insert(h, f);
            h
        }
        Err(e) => {
            log::error!("svp_open failed: {}", e);
            0
        }
    }
}


/// Repr-C struct returning header info to Swift. All numeric fields are
/// native-endian; Swift reads them as Int / UInt directly.
#[repr(C)]
pub struct SvpHeaderInfo {
    pub video_id: [u8; 16],
    pub tenant_id: [u8; 16],
    pub encryption_salt: [u8; 32],
    pub encryption_nonce: [u8; 16],
    pub quality: u16,
    pub chunk_size: u32,
    pub chunk_count: u32,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub original_size: u64,
    pub content_hash: [u8; 32],
}


/// Fill `out` with header info. Returns 1 on success, 0 if the handle is
/// unknown.
///
/// # Safety
/// `out` must point to a valid, initialized SvpHeaderInfo struct (Swift
/// passes a mutable pointer to a stack-allocated value).
#[no_mangle]
pub unsafe extern "C" fn svp_header(handle: i64, out: *mut SvpHeaderInfo) -> c_int {
    if out.is_null() {
        return 0;
    }
    let registry = REGISTRY.lock().unwrap();
    let Some(f) = registry.get(&handle) else {
        return 0;
    };
    let h = &f.header;
    let info = SvpHeaderInfo {
        video_id: h.video_id,
        tenant_id: h.tenant_id,
        encryption_salt: h.encryption_salt,
        encryption_nonce: h.encryption_nonce,
        quality: h.quality,
        chunk_size: h.chunk_size,
        chunk_count: h.chunk_count,
        duration_ms: h.duration_ms,
        width: h.width,
        height: h.height,
        original_size: h.original_size,
        content_hash: h.content_hash,
    };
    *out = info;
    1
}


/// Decrypt one chunk by index. Writes plaintext into `out` (caller-provided
/// buffer of `out_capacity` bytes). Returns the number of bytes written on
/// success, or a negative error code:
///   -1 → unknown handle
///   -2 → master key wrong length
///   -3 → chunk index out of range
///   -4 → chunk hash mismatch (tampered)
///   -5 → decrypt error
///   -6 → caller buffer too small
///
/// # Safety
/// All pointers must be valid for their declared lengths.
#[no_mangle]
pub unsafe extern "C" fn svp_decrypt_chunk(
    handle: i64,
    chunk_index: u32,
    master_key: *const u8,
    master_key_len: usize,
    out: *mut u8,
    out_capacity: usize,
) -> c_long {
    if master_key.is_null() || out.is_null() {
        return -2;
    }
    if master_key_len != 32 {
        return -2;
    }

    let mut registry = REGISTRY.lock().unwrap();
    let Some(f) = registry.get_mut(&handle) else {
        return -1;
    };

    let mk_slice = std::slice::from_raw_parts(master_key, master_key_len);
    let mut mk = [0u8; 32];
    mk.copy_from_slice(mk_slice);

    let key = match SecureKey::derive_video_key(
        &mk,
        &f.header.encryption_salt,
        &f.header.video_id,
        &f.header.tenant_id,
        f.header.quality,
    ) {
        Ok(k) => k,
        Err(e) => {
            log::error!("HKDF: {}", e);
            return -5;
        }
    };

    let idx = chunk_index as usize;
    let encrypted = match f.read_chunk(idx) {
        Ok(b) => b,
        Err(_) => return -3,
    };
    if !f.verify_chunk_hash(idx, &encrypted) {
        return -4;
    }

    let plaintext = match decrypt_chunk(&key, &f.header.encryption_nonce, idx as u64, &encrypted) {
        Ok(p) => p,
        Err(_) => return -5,
    };

    if plaintext.len() > out_capacity {
        return -6;
    }
    let dst = std::slice::from_raw_parts_mut(out, plaintext.len());
    dst.copy_from_slice(&plaintext);
    plaintext.len() as c_long
}


/// Free a handle. Idempotent — calling twice is harmless.
#[no_mangle]
pub extern "C" fn svp_close(handle: i64) {
    REGISTRY.lock().unwrap().remove(&handle);
}


/// Initialize logging — Swift calls this once at app launch.
#[no_mangle]
pub extern "C" fn svp_init_logging() {
    #[cfg(target_os = "ios")]
    {
        let _ = oslog::OsLogger::new("com.svp.player")
            .level_filter(log::LevelFilter::Info)
            .init();
    }
    log::info!("svf-core-ffi initialized");
}
