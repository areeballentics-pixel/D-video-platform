// svf.rs — Reader + writer for the .svf (Secure Video Format) container.
//
// The binary format is defined in shared/svf_spec.md. All integers are
// little-endian. SvfFile is the read path (used by players); SvfWriter is
// the write path (used by the encryptor app and tools/encrypt CLI).

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::errors::SvfCoreError;

// ─── Constants ───

pub const SVF_MAGIC: [u8; 4] = [0x53, 0x56, 0x46, 0x01];
pub const SVF_MAGIC_END: [u8; 4] = [0x45, 0x4E, 0x44, 0x21];
pub const SVF_VERSION: u16 = 1;

/// Bytes from start of file up to (and not including) `title_length`.
/// Matches `0xAC` in the spec layout.
const FIXED_HEADER_SIZE: usize = 172;

/// Size of one chunk index entry: u64 offset + u32 size + 32B hash.
const CHUNK_INDEX_ENTRY_SIZE: usize = 8 + 4 + 32;

/// Maximum title length in bytes (truncated UTF-8).
const MAX_TITLE_BYTES: usize = 512;

// ─── Types ───

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub enum Quality {
    Q480p = 0,
    Q720p = 1,
    Q1080p = 2,
}

#[derive(Debug, Clone, Serialize)]
pub struct SvfHeader {
    pub version: u16,
    pub video_id: [u8; 16],
    pub tenant_id: [u8; 16],
    pub encryption_salt: [u8; 32],
    pub encryption_nonce: [u8; 16],
    pub chunk_size: u32,
    pub chunk_count: u32,
    pub quality: u16,
    pub codec: u16,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub duration_ms: u64,
    pub original_size: u64,
    pub encrypted_size: u64,
    pub content_hash: [u8; 32],
    pub title: String,
}

#[derive(Debug, Clone)]
pub struct ChunkIndexEntry {
    pub offset: u64,
    pub encrypted_size: u32,
    pub hash: [u8; 32],
}

#[derive(Debug, Clone, Serialize)]
pub struct SvfInfo {
    pub video_id: String,
    pub title: String,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub quality: String,
}

pub struct SvfFile {
    pub header: SvfHeader,
    pub chunk_index: Vec<ChunkIndexEntry>,
    reader: BufReader<File>,
}

// ─── SvfHeader methods ───

impl SvfHeader {
    pub fn video_id_hex(&self) -> String {
        hex::encode(self.video_id)
    }

    pub fn quality_label(&self) -> &'static str {
        match self.quality {
            0 => "480p",
            1 => "720p",
            2 => "1080p",
            _ => "unknown",
        }
    }

    pub fn to_info(&self) -> SvfInfo {
        SvfInfo {
            video_id: self.video_id_hex(),
            title: self.title.clone(),
            duration_ms: self.duration_ms,
            width: self.width,
            height: self.height,
            quality: self.quality_label().to_string(),
        }
    }
}

// ─── SvfFile (reader) ───

impl SvfFile {
    /// Open and parse an .svf file. Reads header + chunk index into memory;
    /// chunk data is read on demand via `read_chunk()`.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, SvfCoreError> {
        let file = File::open(path.as_ref())
            .map_err(|e| SvfCoreError::SvfParse(format!("Cannot open file: {}", e)))?;
        let mut reader = BufReader::new(file);

        let mut magic = [0u8; 4];
        reader.read_exact(&mut magic).map_err(|e| {
            SvfCoreError::SvfParse(format!("Cannot read magic bytes: {}", e))
        })?;

        if magic != SVF_MAGIC {
            return Err(SvfCoreError::SvfParse(format!(
                "Invalid magic bytes: expected {:?}, got {:?}",
                SVF_MAGIC, magic
            )));
        }

        let version = reader.read_u16::<LittleEndian>()?;
        if version != SVF_VERSION {
            return Err(SvfCoreError::SvfParse(format!(
                "Unsupported version: {} (expected {})",
                version, SVF_VERSION
            )));
        }

        let _flags = reader.read_u16::<LittleEndian>()?;

        let mut video_id = [0u8; 16];
        reader.read_exact(&mut video_id)?;

        let mut tenant_id = [0u8; 16];
        reader.read_exact(&mut tenant_id)?;

        let mut encryption_salt = [0u8; 32];
        reader.read_exact(&mut encryption_salt)?;

        let mut encryption_nonce = [0u8; 16];
        reader.read_exact(&mut encryption_nonce)?;

        let chunk_size = reader.read_u32::<LittleEndian>()?;
        let chunk_count = reader.read_u32::<LittleEndian>()?;
        let quality = reader.read_u16::<LittleEndian>()?;
        let codec = reader.read_u16::<LittleEndian>()?;
        let width = reader.read_u32::<LittleEndian>()?;
        let height = reader.read_u32::<LittleEndian>()?;
        let fps_num = reader.read_u32::<LittleEndian>()?;
        let fps_den = reader.read_u32::<LittleEndian>()?;
        let duration_ms = reader.read_u64::<LittleEndian>()?;
        let original_size = reader.read_u64::<LittleEndian>()?;
        let encrypted_size = reader.read_u64::<LittleEndian>()?;

        let mut content_hash = [0u8; 32];
        reader.read_exact(&mut content_hash)?;

        let title_length = reader.read_u16::<LittleEndian>()? as usize;
        let mut title_bytes = vec![0u8; title_length];
        reader.read_exact(&mut title_bytes)?;
        let title = String::from_utf8(title_bytes).map_err(|e| {
            SvfCoreError::SvfParse(format!("Invalid UTF-8 in title: {}", e))
        })?;

        let chunk_index_offset = reader.read_u32::<LittleEndian>()? as u64;

        let header = SvfHeader {
            version,
            video_id,
            tenant_id,
            encryption_salt,
            encryption_nonce,
            chunk_size,
            chunk_count,
            quality,
            codec,
            width,
            height,
            fps_num,
            fps_den,
            duration_ms,
            original_size,
            encrypted_size,
            content_hash,
            title,
        };

        reader.seek(SeekFrom::Start(chunk_index_offset))?;
        let mut chunk_index = Vec::with_capacity(chunk_count as usize);

        for _ in 0..chunk_count {
            let offset = reader.read_u64::<LittleEndian>()?;
            let enc_size = reader.read_u32::<LittleEndian>()?;
            let mut hash = [0u8; 32];
            reader.read_exact(&mut hash)?;

            chunk_index.push(ChunkIndexEntry {
                offset,
                encrypted_size: enc_size,
                hash,
            });
        }

        Ok(SvfFile {
            header,
            chunk_index,
            reader,
        })
    }

    /// Read the encrypted bytes for a specific chunk. Does NOT decrypt.
    pub fn read_chunk(&mut self, index: usize) -> Result<Vec<u8>, SvfCoreError> {
        if index >= self.chunk_index.len() {
            return Err(SvfCoreError::SvfParse(format!(
                "Chunk index {} out of range (max {})",
                index,
                self.chunk_index.len() - 1
            )));
        }

        let entry = &self.chunk_index[index];
        self.reader.seek(SeekFrom::Start(entry.offset))?;

        let mut data = vec![0u8; entry.encrypted_size as usize];
        self.reader.read_exact(&mut data)?;

        Ok(data)
    }

    /// Verify an encrypted chunk's SHA-256 against the stored hash. Call BEFORE
    /// decrypting to detect tampering.
    pub fn verify_chunk_hash(&self, index: usize, data: &[u8]) -> bool {
        if index >= self.chunk_index.len() {
            return false;
        }

        let expected = &self.chunk_index[index].hash;
        let actual = Sha256::digest(data);

        actual.as_slice() == expected
    }

    pub fn chunk_count(&self) -> usize {
        self.chunk_index.len()
    }

    pub fn info(&self) -> SvfInfo {
        self.header.to_info()
    }
}

// ─── SvfWriter (write path for the encryptor app) ───

/// Static header parameters known when writing begins. `chunk_count`,
/// `encrypted_size`, and `content_hash` are computed during finalize and
/// don't appear here.
#[derive(Debug, Clone)]
pub struct SvfWriterParams {
    pub video_id: [u8; 16],
    pub tenant_id: [u8; 16],
    pub encryption_salt: [u8; 32],
    pub encryption_nonce: [u8; 16],
    pub chunk_size: u32,
    pub quality: u16,
    pub codec: u16,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub duration_ms: u64,
    pub original_size: u64,
    pub title: String,
}

/// Streaming writer for .svf files.
///
/// Encrypted chunks are spooled to a sidecar tmp file as they arrive, with
/// an index entry accumulated for each. Finalize writes the final .svf in one
/// sequential pass: `[header, chunk_index, copy-from-spool, file_hash, END!]`.
/// Peak memory ~= one chunk_size; works for arbitrarily large videos.
pub struct SvfWriter {
    output_path: PathBuf,
    spool_path: PathBuf,
    /// `Option` so `finalize()` can `take()` the BufWriter and drop it before
    /// reopening the spool for reading. `None` after finalize() has consumed it.
    spool: Option<BufWriter<File>>,
    params: SvfWriterParams,
    chunk_index: Vec<ChunkIndexEntry>,
    /// Running offset within the spool file. Patched into absolute file
    /// offsets at finalize once `data_offset` is known.
    spool_offset: u64,
    finalized: bool,
}

impl SvfWriter {
    /// Create a new writer. Validates the title length and prepares the spool.
    pub fn create<P: AsRef<Path>>(
        output_path: P,
        params: SvfWriterParams,
    ) -> Result<Self, SvfCoreError> {
        let output_path = output_path.as_ref().to_path_buf();

        if params.title.as_bytes().len() > MAX_TITLE_BYTES {
            return Err(SvfCoreError::SvfParse(format!(
                "Title exceeds {} bytes (got {})",
                MAX_TITLE_BYTES,
                params.title.as_bytes().len()
            )));
        }

        // Spool lives next to the final output. Same filesystem = atomic-ish
        // operations and no cross-volume copy at finalize.
        let spool_path = output_path.with_extension("svf.spool");

        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let spool_file = File::create(&spool_path)?;
        let spool = BufWriter::new(spool_file);

        Ok(SvfWriter {
            output_path,
            spool_path,
            spool: Some(spool),
            params,
            chunk_index: Vec::new(),
            spool_offset: 0,
            finalized: false,
        })
    }

    /// Append one encrypted chunk. Records its size and SHA-256 in the index.
    pub fn append_chunk(&mut self, encrypted: &[u8]) -> Result<(), SvfCoreError> {
        let spool = self.spool.as_mut().ok_or_else(|| {
            SvfCoreError::SvfParse("append_chunk called after finalize".to_string())
        })?;

        let hash = Sha256::digest(encrypted);
        let mut hash_arr = [0u8; 32];
        hash_arr.copy_from_slice(&hash);

        // Spool offset is provisional — patched to absolute file offset in finalize.
        self.chunk_index.push(ChunkIndexEntry {
            offset: self.spool_offset,
            encrypted_size: encrypted.len() as u32,
            hash: hash_arr,
        });

        spool.write_all(encrypted)?;
        self.spool_offset += encrypted.len() as u64;

        Ok(())
    }

    /// Finalize the .svf: write header + index + copy-from-spool + footer in
    /// one sequential pass. Hashes the header+index+chunk-data into the
    /// trailing `file_hash`. Removes the spool file.
    pub fn finalize(mut self, content_hash: [u8; 32]) -> Result<(), SvfCoreError> {
        // Mark finalized first so the Drop impl knows not to do cleanup —
        // we'll handle the spool removal explicitly at the end.
        self.finalized = true;

        // Flush + drop the BufWriter so the spool file is fully written and
        // closed before we reopen it for reading.
        if let Some(mut spool) = self.spool.take() {
            spool.flush()?;
        }

        let title_bytes_full = self.params.title.as_bytes();
        let title_bytes = if title_bytes_full.len() > MAX_TITLE_BYTES {
            &title_bytes_full[..MAX_TITLE_BYTES]
        } else {
            title_bytes_full
        };
        let title_len = title_bytes.len();

        // Layout:
        //   [0, FIXED_HEADER_SIZE)                 fixed header
        //   [FIXED_HEADER_SIZE, +2 + title_len)    title_length + title
        //   next 4 bytes                           chunk_index_offset field
        //   then                                   chunk_index_table
        //   then                                   chunk data (copied from spool)
        //   then                                   file_hash (32B)
        //   then                                   SVF_MAGIC_END (4B)
        let header_block_len = FIXED_HEADER_SIZE + 2 + title_len + 4;
        let chunk_index_offset = header_block_len as u64;
        let chunk_index_table_size = (self.chunk_index.len() * CHUNK_INDEX_ENTRY_SIZE) as u64;
        let data_offset = chunk_index_offset + chunk_index_table_size;

        // Patch spool-relative offsets into absolute file offsets.
        let mut running = data_offset;
        for entry in self.chunk_index.iter_mut() {
            entry.offset = running;
            running += entry.encrypted_size as u64;
        }

        let chunk_count = self.chunk_index.len() as u32;
        let encrypted_size: u64 = self
            .chunk_index
            .iter()
            .map(|e| e.encrypted_size as u64)
            .sum();

        let out_file = File::create(&self.output_path)?;
        let mut out = BufWriter::new(out_file);
        let mut hasher = Sha256::new();

        // ── Fixed header ──
        write_and_hash(&mut out, &mut hasher, &SVF_MAGIC)?;
        write_u16_le(&mut out, &mut hasher, SVF_VERSION)?;
        write_u16_le(&mut out, &mut hasher, 0)?; // flags reserved
        write_and_hash(&mut out, &mut hasher, &self.params.video_id)?;
        write_and_hash(&mut out, &mut hasher, &self.params.tenant_id)?;
        write_and_hash(&mut out, &mut hasher, &self.params.encryption_salt)?;
        write_and_hash(&mut out, &mut hasher, &self.params.encryption_nonce)?;
        write_u32_le(&mut out, &mut hasher, self.params.chunk_size)?;
        write_u32_le(&mut out, &mut hasher, chunk_count)?;
        write_u16_le(&mut out, &mut hasher, self.params.quality)?;
        write_u16_le(&mut out, &mut hasher, self.params.codec)?;
        write_u32_le(&mut out, &mut hasher, self.params.width)?;
        write_u32_le(&mut out, &mut hasher, self.params.height)?;
        write_u32_le(&mut out, &mut hasher, self.params.fps_num)?;
        write_u32_le(&mut out, &mut hasher, self.params.fps_den)?;
        write_u64_le(&mut out, &mut hasher, self.params.duration_ms)?;
        write_u64_le(&mut out, &mut hasher, self.params.original_size)?;
        write_u64_le(&mut out, &mut hasher, encrypted_size)?;
        write_and_hash(&mut out, &mut hasher, &content_hash)?;

        // ── Title (length-prefixed) ──
        write_u16_le(&mut out, &mut hasher, title_len as u16)?;
        write_and_hash(&mut out, &mut hasher, title_bytes)?;

        // ── chunk_index_offset field ──
        write_u32_le(&mut out, &mut hasher, chunk_index_offset as u32)?;

        // ── Chunk index table ──
        for entry in &self.chunk_index {
            write_u64_le(&mut out, &mut hasher, entry.offset)?;
            write_u32_le(&mut out, &mut hasher, entry.encrypted_size)?;
            write_and_hash(&mut out, &mut hasher, &entry.hash)?;
        }

        // ── Chunk data: copy from spool, hashing as we go ──
        let mut spool_in = BufReader::new(File::open(&self.spool_path)?);
        let mut buf = vec![0u8; 1_048_576];
        loop {
            let n = spool_in.read(&mut buf)?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])?;
            hasher.update(&buf[..n]);
        }
        drop(spool_in);

        // ── Footer ──
        let file_hash = hasher.finalize();
        out.write_all(&file_hash)?;
        out.write_all(&SVF_MAGIC_END)?;
        out.flush()?;

        // Best-effort cleanup. If this fails the .svf is still valid; the spool
        // is just a leftover temp file the caller can wipe.
        let _ = std::fs::remove_file(&self.spool_path);

        Ok(())
    }
}

impl Drop for SvfWriter {
    fn drop(&mut self) {
        // If the writer is dropped without finalize(), clean up the spool so
        // we don't leave orphaned temp files on disk. After finalize() the
        // spool was already removed; the `finalized` flag short-circuits.
        if !self.finalized {
            // Drop the BufWriter (if any) before deleting the file.
            let _ = self.spool.take();
            let _ = std::fs::remove_file(&self.spool_path);
        }
    }
}

// ─── Hashing helpers ───

fn write_and_hash(
    out: &mut BufWriter<File>,
    hasher: &mut Sha256,
    bytes: &[u8],
) -> Result<(), SvfCoreError> {
    out.write_all(bytes)?;
    hasher.update(bytes);
    Ok(())
}

fn write_u16_le(
    out: &mut BufWriter<File>,
    hasher: &mut Sha256,
    val: u16,
) -> Result<(), SvfCoreError> {
    let bytes = val.to_le_bytes();
    out.write_u16::<LittleEndian>(val)?;
    hasher.update(&bytes);
    Ok(())
}

fn write_u32_le(
    out: &mut BufWriter<File>,
    hasher: &mut Sha256,
    val: u32,
) -> Result<(), SvfCoreError> {
    let bytes = val.to_le_bytes();
    out.write_u32::<LittleEndian>(val)?;
    hasher.update(&bytes);
    Ok(())
}

fn write_u64_le(
    out: &mut BufWriter<File>,
    hasher: &mut Sha256,
    val: u64,
) -> Result<(), SvfCoreError> {
    let bytes = val.to_le_bytes();
    out.write_u64::<LittleEndian>(val)?;
    hasher.update(&bytes);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_magic_constants() {
        assert_eq!(&SVF_MAGIC, b"SVF\x01");
        assert_eq!(&SVF_MAGIC_END, b"END!");
    }

    #[test]
    fn test_quality_label() {
        let header = SvfHeader {
            version: 1,
            video_id: [0; 16],
            tenant_id: [0; 16],
            encryption_salt: [0; 32],
            encryption_nonce: [0; 16],
            chunk_size: 1048576,
            chunk_count: 1,
            quality: 1,
            codec: 0,
            width: 1280,
            height: 720,
            fps_num: 30,
            fps_den: 1,
            duration_ms: 12000,
            original_size: 1000000,
            encrypted_size: 1000000,
            content_hash: [0; 32],
            title: "Test".to_string(),
        };

        assert_eq!(header.quality_label(), "720p");
        assert_eq!(header.to_info().quality, "720p");
    }

    #[test]
    fn test_writer_roundtrip() {
        // Write a tiny .svf with two chunks, then read it back via SvfFile and
        // verify every field round-trips correctly.
        let tmp = std::env::temp_dir().join(format!(
            "svf-core-writer-test-{}.svf",
            std::process::id()
        ));
        // Best-effort cleanup of any leftover from a prior failed run.
        let _ = std::fs::remove_file(&tmp);

        let params = SvfWriterParams {
            video_id: [0x11; 16],
            tenant_id: [0x22; 16],
            encryption_salt: [0x33; 32],
            encryption_nonce: [0x44; 16],
            chunk_size: 32,
            quality: 1,
            codec: 0,
            width: 1280,
            height: 720,
            fps_num: 30,
            fps_den: 1,
            duration_ms: 5000,
            original_size: 64,
            title: "Roundtrip".to_string(),
        };

        let mut writer = SvfWriter::create(&tmp, params).unwrap();
        let chunk_a = b"first-chunk-encrypted-data-here1";  // 32 bytes
        let chunk_b = b"second-chunk-encrypted-data-here";  // 32 bytes
        writer.append_chunk(chunk_a).unwrap();
        writer.append_chunk(chunk_b).unwrap();
        writer.finalize([0xAB; 32]).unwrap();

        let mut svf = SvfFile::open(&tmp).expect("written .svf must parse");

        assert_eq!(svf.header.video_id, [0x11; 16]);
        assert_eq!(svf.header.tenant_id, [0x22; 16]);
        assert_eq!(svf.header.encryption_salt, [0x33; 32]);
        assert_eq!(svf.header.encryption_nonce, [0x44; 16]);
        assert_eq!(svf.header.chunk_size, 32);
        assert_eq!(svf.header.chunk_count, 2);
        assert_eq!(svf.header.quality, 1);
        assert_eq!(svf.header.width, 1280);
        assert_eq!(svf.header.height, 720);
        assert_eq!(svf.header.duration_ms, 5000);
        assert_eq!(svf.header.original_size, 64);
        assert_eq!(svf.header.encrypted_size, 64);
        assert_eq!(svf.header.content_hash, [0xAB; 32]);
        assert_eq!(svf.header.title, "Roundtrip");

        // Read each chunk back and verify byte identity + hash.
        let read_a = svf.read_chunk(0).unwrap();
        assert_eq!(&read_a, chunk_a);
        assert!(svf.verify_chunk_hash(0, &read_a));

        let read_b = svf.read_chunk(1).unwrap();
        assert_eq!(&read_b, chunk_b);
        assert!(svf.verify_chunk_hash(1, &read_b));

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn test_writer_drop_cleans_spool() {
        // Dropping a writer without finalize() should remove its spool file.
        let tmp = std::env::temp_dir().join(format!(
            "svf-core-drop-test-{}.svf",
            std::process::id()
        ));
        let spool = tmp.with_extension("svf.spool");
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(&spool);

        let params = SvfWriterParams {
            video_id: [0; 16],
            tenant_id: [0; 16],
            encryption_salt: [0; 32],
            encryption_nonce: [0; 16],
            chunk_size: 16,
            quality: 0,
            codec: 0,
            width: 854,
            height: 480,
            fps_num: 30,
            fps_den: 1,
            duration_ms: 1000,
            original_size: 16,
            title: "Drop test".to_string(),
        };

        {
            let writer = SvfWriter::create(&tmp, params).unwrap();
            assert!(spool.exists(), "spool should exist while writer is alive");
            drop(writer);
        }
        assert!(!spool.exists(), "spool should be removed when writer is dropped without finalize");
    }
}
