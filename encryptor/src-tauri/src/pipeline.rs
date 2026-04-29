// pipeline.rs — File-level AES-CTR encryption from input to .svf.
//
// Hot path: read input in 1 MiB chunks → AES-CTR encrypt with svf-core →
// `SvfWriter::append_chunk` → hash plaintext into content_hash → finalize.
//
// No transcoding. No FFmpeg. No subprocess. Encryption speed is bounded by
// disk read speed (~500 MB/s on a typical SSD), which is well below AES-NI
// throughput (~1.5 GB/s per core), so a single-threaded loop is fine for v1.

use std::fs::File;
use std::io::{BufReader, Read};
use sha2::{Digest, Sha256};
use svf_core::{encrypt_chunk, SecureKey, SvfWriter, SvfWriterParams};
use uuid::Uuid;

use crate::errors::AppError;
use crate::mp4_probe::VideoMeta;


pub const CHUNK_SIZE: u32 = 1_048_576; // 1 MiB
pub const QUALITY_ORIGINAL: u16 = 65535;


/// Map a string quality label to the u16 stored in the .svf header.
pub fn quality_label_to_int(label: &str) -> u16 {
    match label {
        "480p" => 0,
        "720p" => 1,
        "1080p" => 2,
        _ => QUALITY_ORIGINAL,
    }
}


/// Inputs the encryptor app gathers per job.
pub struct EncryptJobInputs {
    pub input_path: std::path::PathBuf,
    pub output_path: std::path::PathBuf,
    pub video_id: Uuid,
    pub tenant_id: Uuid,
    pub master_key: [u8; 32],
    pub title: String,
    pub quality_label: String,
    pub meta: VideoMeta,
}


/// What the pipeline returns when finished — exactly what the server's
/// `/api/admin/videos/register-encrypted` endpoint needs.
#[derive(Debug, Clone)]
pub struct EncryptJobResult {
    pub video_id: Uuid,
    pub quality_label: String,
    pub encryption_salt_hex: String,
    pub encryption_nonce_hex: String,
    pub content_hash_hex: String,
    pub svf_file_size: u64,
    pub duration_ms: u64,
}


/// Encrypt one input file into one .svf file.
///
/// `progress` is called with `(bytes_read, total_bytes)` periodically so the
/// caller can emit Tauri events to the React UI.
pub fn encrypt_to_svf<F: FnMut(u64, u64)>(
    job: EncryptJobInputs,
    mut progress: F,
) -> Result<EncryptJobResult, AppError> {
    if !job.input_path.exists() {
        return Err(AppError::Validation(format!(
            "input file not found: {}",
            job.input_path.display()
        )));
    }

    // ── Generate per-quality random salt + nonce ──
    // Different (salt, nonce) per quality means each .svf for the same video_id
    // gets a unique derived key — defense in depth even though HKDF info also
    // includes the quality int. Using OS entropy (getrandom) — failure here
    // is fatal because we can't safely continue with weak randomness.
    let mut encryption_salt = [0u8; 32];
    let mut encryption_nonce = [0u8; 16];
    getrandom::getrandom(&mut encryption_salt)
        .map_err(|e| AppError::Encryption(format!("getrandom failed: {}", e)))?;
    getrandom::getrandom(&mut encryption_nonce)
        .map_err(|e| AppError::Encryption(format!("getrandom failed: {}", e)))?;

    let quality_int = quality_label_to_int(&job.quality_label);

    // ── Derive the per-video AES-256 key via HKDF (matches Python + player) ──
    let key = SecureKey::derive_video_key(
        &job.master_key,
        &encryption_salt,
        job.video_id.as_bytes(),
        job.tenant_id.as_bytes(),
        quality_int,
    )?;

    // ── Open input + spool output ──
    let input_file = File::open(&job.input_path)?;
    let original_size = input_file.metadata()?.len();
    let mut reader = BufReader::with_capacity(CHUNK_SIZE as usize, input_file);

    let params = SvfWriterParams {
        video_id: *job.video_id.as_bytes(),
        tenant_id: *job.tenant_id.as_bytes(),
        encryption_salt,
        encryption_nonce,
        chunk_size: CHUNK_SIZE,
        quality: quality_int,
        codec: 0, // H.264 — assumed for v1; the encryptor doesn't transcode
        width: job.meta.width,
        height: job.meta.height,
        fps_num: job.meta.fps_num,
        fps_den: job.meta.fps_den,
        duration_ms: job.meta.duration_ms,
        original_size,
        title: job.title.clone(),
    };

    let mut writer = SvfWriter::create(&job.output_path, params)?;

    // ── Read → encrypt → append, accumulating SHA-256 of plaintext ──
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK_SIZE as usize];
    let mut chunk_index: u64 = 0;
    let mut total_read: u64 = 0;
    let mut last_progress_emit: u64 = 0;

    loop {
        let n = read_full_or_eof(&mut reader, &mut buf)?;
        if n == 0 {
            break;
        }
        let plaintext = &buf[..n];

        hasher.update(plaintext);

        let ciphertext = encrypt_chunk(&key, &encryption_nonce, chunk_index, plaintext)?;
        writer.append_chunk(&ciphertext)?;

        chunk_index += 1;
        total_read += n as u64;

        // Emit progress at most every 4 MiB to avoid IPC chatter.
        if total_read - last_progress_emit >= 4 * 1024 * 1024 || total_read == original_size {
            progress(total_read, original_size);
            last_progress_emit = total_read;
        }
    }

    let content_hash = hasher.finalize();
    let mut content_hash_arr = [0u8; 32];
    content_hash_arr.copy_from_slice(&content_hash);

    writer.finalize(content_hash_arr)?;

    // Final stat for file size + a final progress tick.
    let svf_file_size = std::fs::metadata(&job.output_path)?.len();
    progress(original_size, original_size);

    Ok(EncryptJobResult {
        video_id: job.video_id,
        quality_label: job.quality_label,
        encryption_salt_hex: hex::encode(encryption_salt),
        encryption_nonce_hex: hex::encode(encryption_nonce),
        content_hash_hex: hex::encode(content_hash_arr),
        svf_file_size,
        duration_ms: job.meta.duration_ms,
    })
}


/// `BufReader::read` is allowed to return short reads. Loop until either the
/// buffer is full OR we hit EOF. Returns the number of bytes read this call.
fn read_full_or_eof<R: Read>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::mp4_probe::VideoMeta;
    use std::io::Write;
    use svf_core::{decrypt_chunk, SvfFile};

    /// End-to-end: encrypt a multi-chunk plaintext, parse the .svf, derive the
    /// same key via HKDF, decrypt each chunk, and verify byte-for-byte recovery
    /// plus content_hash correctness.
    #[test]
    fn pipeline_roundtrip_recovers_plaintext_and_hash() {
        // Build ~3 MiB of pseudo-random plaintext so we cross the 1 MiB chunk
        // boundary multiple times and exercise the chunk index logic.
        let plaintext: Vec<u8> = (0u32..(3 * 1024 * 1024 + 137))
            .map(|i| (i.wrapping_mul(2_654_435_761) & 0xFF) as u8)
            .collect();
        let expected_hash = {
            let mut h = Sha256::new();
            h.update(&plaintext);
            h.finalize()
        };

        let tmpdir = std::env::temp_dir().join(format!("svp-pipeline-{}", std::process::id()));
        std::fs::create_dir_all(&tmpdir).unwrap();
        let input_path = tmpdir.join("plain.bin");
        let output_path = tmpdir.join("encrypted.svf");
        {
            let mut f = std::fs::File::create(&input_path).unwrap();
            f.write_all(&plaintext).unwrap();
        }

        // Fixed test inputs so the test is deterministic across reruns.
        let master_key: [u8; 32] = [0xA5; 32];
        let video_id = Uuid::from_u128(0x1111_1111_1111_1111_1111_1111_1111_1111);
        let tenant_id = Uuid::from_u128(0x2222_2222_2222_2222_2222_2222_2222_2222);
        let meta = VideoMeta {
            width: 1280,
            height: 720,
            duration_ms: 5000,
            fps_num: 30,
            fps_den: 1,
            quality_label: "720p".to_string(),
        };

        let result = encrypt_to_svf(
            EncryptJobInputs {
                input_path: input_path.clone(),
                output_path: output_path.clone(),
                video_id,
                tenant_id,
                master_key,
                title: "pipeline test".to_string(),
                quality_label: meta.quality_label.clone(),
                meta: meta.clone(),
            },
            |_p, _t| {},
        )
        .expect("encryption must succeed");

        // ── Verify content_hash matches SHA-256 of plaintext ──
        assert_eq!(
            result.content_hash_hex,
            hex::encode(expected_hash.as_slice()),
            "content_hash must match SHA-256(plaintext)"
        );

        // ── Parse the .svf via SvfFile (same code path the player uses) ──
        let mut svf = SvfFile::open(&output_path).expect("written .svf must parse");
        assert_eq!(svf.header.video_id.as_slice(), video_id.as_bytes());
        assert_eq!(svf.header.tenant_id.as_slice(), tenant_id.as_bytes());
        assert_eq!(svf.header.title, "pipeline test");
        assert_eq!(svf.header.quality, 1, "720p maps to int 1");
        assert_eq!(svf.header.original_size, plaintext.len() as u64);

        // ── Derive the same key + decrypt every chunk ──
        let key = SecureKey::derive_video_key(
            &master_key,
            &svf.header.encryption_salt,
            &svf.header.video_id,
            &svf.header.tenant_id,
            svf.header.quality,
        )
        .expect("HKDF must succeed");

        let mut recovered = Vec::with_capacity(plaintext.len());
        for i in 0..svf.chunk_count() {
            let ct = svf.read_chunk(i).expect("read_chunk");
            assert!(svf.verify_chunk_hash(i, &ct), "chunk {} hash mismatch", i);
            let pt = decrypt_chunk(&key, &svf.header.encryption_nonce, i as u64, &ct)
                .expect("decrypt_chunk");
            recovered.extend_from_slice(&pt);
        }

        assert_eq!(recovered.len(), plaintext.len());
        assert_eq!(
            Sha256::digest(&recovered).as_slice(),
            expected_hash.as_slice(),
            "recovered plaintext must match original byte-for-byte"
        );

        let _ = std::fs::remove_file(&input_path);
        let _ = std::fs::remove_file(&output_path);
        let _ = std::fs::remove_dir(&tmpdir);
    }
}


