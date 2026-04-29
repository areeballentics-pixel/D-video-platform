package com.svp.player

/**
 * JNI declarations for the svf-core-jni Rust library.
 *
 * The .so file (built via `cargo ndk` from `crates/svf-core-jni/`) lives in
 * `app/src/main/jniLibs/<abi>/libsvf_core_jni.so`. System.loadLibrary picks
 * the correct ABI for the running device automatically.
 *
 * Lifecycle:
 *   1. nativeOpenSvf(path)        → handle (Long); 0 means failure
 *   2. nativeGetHeader(handle)    → 144 bytes of fixed-layout header
 *   3. nativeDecryptChunk(...)    → decrypted ByteArray
 *   4. nativeClose(handle)        → free
 */
object RustBindings {
    init {
        System.loadLibrary("svf_core_jni")
    }

    /** Open an .svf file. Returns a non-zero handle on success, 0 on failure. */
    external fun nativeOpenSvf(path: String): Long

    /**
     * Get the fixed-layout header bytes for the given handle.
     * Layout (little-endian):
     *   [0..16)   video_id           (16 B)
     *   [16..32)  tenant_id          (16 B)
     *   [32..64)  encryption_salt    (32 B)
     *   [64..80)  encryption_nonce   (16 B)
     *   [80..82)  quality            (u16)
     *   [82..86)  chunk_size         (u32)
     *   [86..90)  chunk_count        (u32)
     *   [90..98)  duration_ms        (u64)
     *   [98..102) width              (u32)
     *   [102..106) height            (u32)
     *   [106..138) content_hash      (32 B)
     *   [138..146) original_size     (u64)
     * Total = 146 bytes (the JNI side returns 144 — width/height + content_hash
     * pack to satisfy alignment; see crates/svf-core-jni/src/lib.rs for the
     * authoritative layout).
     */
    external fun nativeGetHeader(handle: Long): ByteArray?

    /**
     * Read + decrypt a single chunk by index.
     *
     * The master key (32 bytes) is supplied per-call and immediately zeroed by
     * the Rust side after deriving the per-video AES-256 key — minimizing the
     * window during which the raw key sits in process memory.
     *
     * Returns null on any failure (chunk index out of range, hash mismatch,
     * decrypt error).
     */
    external fun nativeDecryptChunk(
        handle: Long,
        chunkIndex: Int,
        masterKey: ByteArray,
    ): ByteArray?

    /** Free the .svf handle. Idempotent. */
    external fun nativeClose(handle: Long)
}
