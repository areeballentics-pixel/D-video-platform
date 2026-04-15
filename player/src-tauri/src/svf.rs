// svf.rs — Parser for the .svf (Secure Video Format) container
//
// This module reads and validates .svf files produced by the Python
// encryption tool. It parses the binary header, chunk index, and
// provides methods to read individual encrypted chunks for decryption.
//
// The binary format is defined in shared/svf_spec.md.
// All integers are little-endian.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use byteorder::{LittleEndian, ReadBytesExt};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::errors::AppError;

// ─── Constants ───

/// Magic bytes at the start of every .svf file: "SVF\x01"
pub const SVF_MAGIC: [u8; 4] = [0x53, 0x56, 0x46, 0x01];

/// Magic bytes at the end of every .svf file: "END!"
pub const SVF_MAGIC_END: [u8; 4] = [0x45, 0x4E, 0x44, 0x21];

/// Current format version
pub const SVF_VERSION: u16 = 1;

// ─── Types ───

/// Video quality level
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub enum Quality {
    Q480p = 0,
    Q720p = 1,
    Q1080p = 2,
}

/// Parsed header from an .svf file
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

/// One entry in the chunk index table
#[derive(Debug, Clone)]
pub struct ChunkIndexEntry {
    pub offset: u64,
    pub encrypted_size: u32,
    pub hash: [u8; 32],
}

/// Info sent to the frontend (serializable subset of SvfHeader)
#[derive(Debug, Clone, Serialize)]
pub struct SvfInfo {
    pub video_id: String,
    pub title: String,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub quality: String,
}

/// An open .svf file ready for chunk reading.
///
/// Holds the parsed header, chunk index, and an open file handle.
/// The file handle is kept open so we can seek to any chunk on demand
/// without re-opening the file (important for smooth video playback).
pub struct SvfFile {
    pub header: SvfHeader,
    pub chunk_index: Vec<ChunkIndexEntry>,
    reader: BufReader<File>,
}

// ─── SvfHeader methods ───

impl SvfHeader {
    /// Convert video_id bytes to a hex string
    pub fn video_id_hex(&self) -> String {
        hex::encode(self.video_id)
    }

    /// Get quality as a display string
    pub fn quality_label(&self) -> &'static str {
        match self.quality {
            0 => "480p",
            1 => "720p",
            2 => "1080p",
            _ => "unknown",
        }
    }

    /// Convert to frontend-friendly info struct
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

// ─── SvfFile implementation ───

impl SvfFile {
    /// Open and parse an .svf file.
    ///
    /// This reads the header and chunk index into memory, but does NOT
    /// read the actual encrypted chunk data — that happens on demand
    /// via read_chunk().
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, AppError> {
        let file = File::open(path.as_ref()).map_err(|e| {
            AppError::SvfParse(format!("Cannot open file: {}", e))
        })?;
        let mut reader = BufReader::new(file);

        // ── Step 1: Validate magic bytes ──
        let mut magic = [0u8; 4];
        reader.read_exact(&mut magic).map_err(|e| {
            AppError::SvfParse(format!("Cannot read magic bytes: {}", e))
        })?;

        if magic != SVF_MAGIC {
            return Err(AppError::SvfParse(format!(
                "Invalid magic bytes: expected {:?}, got {:?}",
                SVF_MAGIC, magic
            )));
        }

        // ── Step 2: Read fixed header fields ──
        // Each read_xxx::<LittleEndian>() reads the exact number of bytes
        // for that type and interprets them as little-endian.
        let version = reader.read_u16::<LittleEndian>()?;
        if version != SVF_VERSION {
            return Err(AppError::SvfParse(format!(
                "Unsupported version: {} (expected {})",
                version, SVF_VERSION
            )));
        }

        let _flags = reader.read_u16::<LittleEndian>()?; // reserved

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

        // ── Step 3: Read variable-length title ──
        let title_length = reader.read_u16::<LittleEndian>()? as usize;
        let mut title_bytes = vec![0u8; title_length];
        reader.read_exact(&mut title_bytes)?;
        let title = String::from_utf8(title_bytes).map_err(|e| {
            AppError::SvfParse(format!("Invalid UTF-8 in title: {}", e))
        })?;

        // ── Step 4: Read chunk index offset ──
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

        // ── Step 5: Read chunk index table ──
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

    /// Read the encrypted data for a specific chunk.
    ///
    /// Seeks to the chunk's offset in the file and reads exactly
    /// `encrypted_size` bytes. Does NOT decrypt — that's crypto.rs's job.
    pub fn read_chunk(&mut self, index: usize) -> Result<Vec<u8>, AppError> {
        if index >= self.chunk_index.len() {
            return Err(AppError::SvfParse(format!(
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

    /// Verify a chunk's SHA-256 hash matches the stored hash.
    ///
    /// Call this BEFORE decrypting to detect file corruption or tampering.
    pub fn verify_chunk_hash(&self, index: usize, data: &[u8]) -> bool {
        if index >= self.chunk_index.len() {
            return false;
        }

        let expected = &self.chunk_index[index].hash;
        let actual = Sha256::digest(data);

        actual.as_slice() == expected
    }

    /// Get the total number of chunks in this file.
    pub fn chunk_count(&self) -> usize {
        self.chunk_index.len()
    }

    /// Get frontend-friendly info about this video.
    pub fn info(&self) -> SvfInfo {
        self.header.to_info()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_magic_constants() {
        // "SVF\x01" in ASCII
        assert_eq!(&SVF_MAGIC, b"SVF\x01");
        // "END!" in ASCII
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
}
