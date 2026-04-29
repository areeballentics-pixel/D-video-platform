// svf-core-jni — JNI bridge from svf-core into Android Kotlin.
//
// Exposes a small handle-based API:
//   - nativeOpenSvf(path)        → handle (long)  / 0 on error
//   - nativeGetHeader(handle)    → ByteBuffer with serialized header (TLV-ish)
//   - nativeReadChunk(handle, idx, key, base_nonce) → decrypted ByteBuffer
//   - nativeChunkInfo(handle, idx) → (offset, encrypted_size, plaintext_size)
//   - nativeClose(handle)        → free
//
// Decrypted bytes return as a Java direct ByteBuffer that the Kotlin caller
// can pass straight to ExoPlayer's DataSource — never written to disk.

use std::collections::HashMap;
use std::sync::Mutex;

use jni::objects::{JByteArray, JClass, JString};
use jni::sys::{jbyteArray, jint, jlong, jobject};
use jni::JNIEnv;
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


/// JNI entry: open an .svf file by path and return a handle (jlong) used by
/// subsequent calls. Returns 0 on any error.
#[no_mangle]
pub extern "system" fn Java_com_svp_player_RustBindings_nativeOpenSvf<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    path: JString<'a>,
) -> jlong {
    let path_str: String = match env.get_string(&path) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    match SvfFile::open(&path_str) {
        Ok(file) => {
            let h = next_handle();
            REGISTRY.lock().unwrap().insert(h, file);
            h
        }
        Err(e) => {
            log::error!("nativeOpenSvf failed: {}", e);
            0
        }
    }
}


/// JNI entry: get header info as a byte array.
/// Layout (LE):
///   16B video_id, 16B tenant_id, 32B encryption_salt, 16B encryption_nonce,
///   2B quality, 4B chunk_size, 4B chunk_count, 8B duration_ms,
///   4B width, 4B height, 32B content_hash, 8B original_size
/// Total = 144 bytes. Title omitted to keep parsing trivial in Kotlin.
#[no_mangle]
pub extern "system" fn Java_com_svp_player_RustBindings_nativeGetHeader<'a>(
    env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
) -> jbyteArray {
    let registry = REGISTRY.lock().unwrap();
    let Some(file) = registry.get(&handle) else {
        return std::ptr::null_mut();
    };
    let h = &file.header;

    let mut buf = Vec::with_capacity(144);
    buf.extend_from_slice(&h.video_id);
    buf.extend_from_slice(&h.tenant_id);
    buf.extend_from_slice(&h.encryption_salt);
    buf.extend_from_slice(&h.encryption_nonce);
    buf.extend_from_slice(&h.quality.to_le_bytes());
    buf.extend_from_slice(&h.chunk_size.to_le_bytes());
    buf.extend_from_slice(&h.chunk_count.to_le_bytes());
    buf.extend_from_slice(&h.duration_ms.to_le_bytes());
    buf.extend_from_slice(&h.width.to_le_bytes());
    buf.extend_from_slice(&h.height.to_le_bytes());
    buf.extend_from_slice(&h.content_hash);
    buf.extend_from_slice(&h.original_size.to_le_bytes());

    let arr = match env.byte_array_from_slice(&buf) {
        Ok(a) => a,
        Err(_) => return std::ptr::null_mut(),
    };
    arr.into_raw()
}


/// JNI entry: read + decrypt one chunk by index. Caller supplies the master
/// key (32 bytes) — svf-core derives the per-video key locally so the master
/// key never crosses to disk or to Java for long.
#[no_mangle]
pub extern "system" fn Java_com_svp_player_RustBindings_nativeDecryptChunk<'a>(
    env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
    chunk_index: jint,
    master_key: JByteArray<'a>,
) -> jbyteArray {
    let mut registry = REGISTRY.lock().unwrap();
    let Some(file) = registry.get_mut(&handle) else {
        return std::ptr::null_mut();
    };

    let mk_bytes: Vec<u8> = match env.convert_byte_array(&master_key) {
        Ok(b) => b,
        Err(_) => return std::ptr::null_mut(),
    };
    if mk_bytes.len() != 32 {
        log::error!("master key must be 32 bytes, got {}", mk_bytes.len());
        return std::ptr::null_mut();
    }
    let mut mk = [0u8; 32];
    mk.copy_from_slice(&mk_bytes);

    // Derive per-video key (this is cheap so we don't bother caching across
    // chunks — keeps the Java side from holding the SecureKey).
    let key = match SecureKey::derive_video_key(
        &mk,
        &file.header.encryption_salt,
        &file.header.video_id,
        &file.header.tenant_id,
        file.header.quality,
    ) {
        Ok(k) => k,
        Err(e) => {
            log::error!("HKDF failed: {}", e);
            return std::ptr::null_mut();
        }
    };

    let idx = chunk_index as usize;
    let encrypted = match file.read_chunk(idx) {
        Ok(b) => b,
        Err(e) => {
            log::error!("read_chunk failed: {}", e);
            return std::ptr::null_mut();
        }
    };

    if !file.verify_chunk_hash(idx, &encrypted) {
        log::error!("chunk {} hash mismatch — file tampered", idx);
        return std::ptr::null_mut();
    }

    let decrypted = match decrypt_chunk(
        &key,
        &file.header.encryption_nonce,
        idx as u64,
        &encrypted,
    ) {
        Ok(p) => p,
        Err(e) => {
            log::error!("decrypt_chunk failed: {}", e);
            return std::ptr::null_mut();
        }
    };

    match env.byte_array_from_slice(&decrypted) {
        Ok(a) => a.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}


/// JNI entry: free the file handle.
#[no_mangle]
pub extern "system" fn Java_com_svp_player_RustBindings_nativeClose<'a>(
    _env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
) {
    REGISTRY.lock().unwrap().remove(&handle);
}


/// JNI_OnLoad — initialize Android logging so log::error! / log::info! show
/// up in `adb logcat`. Called automatically when the JVM loads the .so.
#[no_mangle]
pub extern "system" fn JNI_OnLoad(
    _vm: *mut std::ffi::c_void,
    _reserved: *mut std::ffi::c_void,
) -> jint {
    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("svf-core-jni"),
    );
    log::info!("svf-core-jni loaded");
    // JNI version 1.6 — supported by every Android version we target.
    0x0001_0006
}


/// Suppress the unused-import warning when building for non-Android targets
/// (devs may run `cargo check` on the workspace from a desktop).
#[allow(dead_code)]
fn _unused_for_desktop_check(_: jobject) {}
