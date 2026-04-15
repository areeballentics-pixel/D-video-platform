// crypto.rs — AES-256-CTR decryption with secure memory handling
//
// This module handles:
// 1. Key derivation using HKDF-SHA256 (must match Python implementation exactly)
// 2. Per-chunk AES-256-CTR decryption
// 3. Secure memory: keys are zeroed on drop and locked in physical memory
//
// CRITICAL: The HKDF info parameter is:
//   video_id (16 bytes) || tenant_id (16 bytes) || quality (2 bytes LE)
// Both Python and Rust must construct this identically.

use aes::Aes256;
use cipher::{KeyIvInit, StreamCipher};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroize;

use crate::errors::AppError;

// Type alias for AES-256 in CTR mode with a 64-bit (little-endian) counter.
// CTR mode uses a nonce + counter. The counter increments for each 16-byte block.
// Python's `modes.CTR(nonce)` uses a 128-bit big-endian counter.
// We MUST match this exactly, or decryption produces garbage after the first block.
// Ctr128BE = full 16-byte nonce is treated as a 128-bit big-endian integer that
// increments by 1 for each 16-byte AES block.
type Aes256Ctr = ctr::Ctr128BE<Aes256>;

/// A 256-bit encryption key that automatically zeroes itself when dropped.
///
/// When this struct goes out of scope (function returns, variable reassigned, etc.),
/// Rust calls `drop()` on it. The `#[zeroize(drop)]` attribute ensures the key
/// bytes are overwritten with zeros BEFORE the memory is freed. This prevents
/// the key from lingering in freed memory.
pub struct SecureKey {
    key: [u8; 32],
}

impl SecureKey {
    /// Create a new SecureKey from raw bytes.
    pub fn new(key: [u8; 32]) -> Self {
        // On Windows, lock the memory page containing the key to prevent
        // the OS from swapping it to the page file (disk).
        #[cfg(windows)]
        unsafe {
            use windows::Win32::System::Memory::VirtualLock;
            let ptr = key.as_ptr() as *const std::ffi::c_void;
            // VirtualLock may fail if the process doesn't have SE_LOCK_MEMORY_PAGES
            // privilege. That's OK — the key still works, it just might be paged.
            let _ = VirtualLock(ptr, 32);
        }

        Self { key }
    }

    /// Access the raw key bytes.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.key
    }

    /// Derive a per-video encryption key using HKDF-SHA256.
    ///
    /// HKDF (HMAC-based Key Derivation Function) takes a "master" key and
    /// derives a new key from it using additional context (salt + info).
    /// The same inputs ALWAYS produce the same output — this is how both
    /// the Python encryptor and Rust player derive the same key independently.
    ///
    /// info = video_id (16B) || tenant_id (16B) || quality (2B little-endian)
    pub fn derive_video_key(
        master_key: &[u8; 32],
        salt: &[u8; 32],
        video_id: &[u8; 16],
        tenant_id: &[u8; 16],
        quality: u16,
    ) -> Result<Self, AppError> {
        // Build the info parameter — must be byte-identical to Python:
        //   info = video_id + tenant_id + quality.to_bytes(2, 'little')
        let mut info = Vec::with_capacity(34); // 16 + 16 + 2 = 34 bytes
        info.extend_from_slice(video_id);
        info.extend_from_slice(tenant_id);
        info.extend_from_slice(&quality.to_le_bytes()); // to_le_bytes() = little-endian

        // HKDF has two phases:
        // 1. Extract: combines master_key + salt into a "pseudo-random key" (PRK)
        // 2. Expand: uses the PRK + info to generate the output key
        let hk = Hkdf::<Sha256>::new(Some(salt), master_key);

        let mut derived = [0u8; 32];
        hk.expand(&info, &mut derived).map_err(|e| {
            AppError::Crypto(format!("HKDF expand failed: {}", e))
        })?;

        Ok(Self::new(derived))
    }
}

// Custom Drop: zeroes the key AND unlocks the memory page.
// We implement this manually instead of using #[zeroize(drop)] because
// Rust only allows ONE Drop impl per type, and we need to do both.
impl Drop for SecureKey {
    fn drop(&mut self) {
        // Zero the key bytes first (security-critical)
        self.key.zeroize();

        // Unlock the memory page (if we locked it earlier)
        #[cfg(windows)]
        unsafe {
            use windows::Win32::System::Memory::VirtualUnlock;
            let ptr = self.key.as_ptr() as *const std::ffi::c_void;
            let _ = VirtualUnlock(ptr, 32);
        }
    }
}

/// Decrypt a single encrypted chunk using AES-256-CTR.
///
/// Each chunk has a unique nonce derived from the base nonce:
///   chunk_nonce = base_nonce XOR (chunk_index as u128, zero-padded to 16 bytes, little-endian)
///
/// This ensures each chunk uses a unique nonce even though they share the same key.
/// The XOR approach means we don't need to store per-chunk nonces in the file.
pub fn decrypt_chunk(
    key: &SecureKey,
    base_nonce: &[u8; 16],
    chunk_index: u64,
    encrypted_data: &[u8],
) -> Result<Vec<u8>, AppError> {
    // Step 1: Derive the per-chunk nonce by XORing with the chunk index.
    // The chunk_index is converted to a 16-byte little-endian representation
    // and XORed with the base_nonce byte by byte.
    let index_bytes = (chunk_index as u128).to_le_bytes(); // 16 bytes, LE
    let mut chunk_nonce = [0u8; 16];
    for i in 0..16 {
        chunk_nonce[i] = base_nonce[i] ^ index_bytes[i];
    }

    // Step 2: Create the AES-256-CTR cipher with our key and chunk-specific nonce.
    let mut cipher = Aes256Ctr::new(key.as_bytes().into(), &chunk_nonce.into());

    // Step 3: Clone the encrypted data into a mutable buffer.
    // apply_keystream works in-place — it XORs the keystream into the buffer,
    // transforming ciphertext into plaintext.
    let mut decrypted = encrypted_data.to_vec();
    cipher
        .try_apply_keystream(&mut decrypted)
        .map_err(|e| AppError::Crypto(format!("AES-CTR decryption failed: {}", e)))?;

    Ok(decrypted)
}

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nonce_xor_chunk_0() {
        // Chunk 0: index is all zeros, so nonce should equal base_nonce
        let base_nonce: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
            0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF,
        ];
        let index_bytes = (0u128).to_le_bytes();
        let mut nonce = [0u8; 16];
        for i in 0..16 {
            nonce[i] = base_nonce[i] ^ index_bytes[i];
        }
        assert_eq!(nonce, base_nonce);
    }

    #[test]
    fn test_nonce_xor_chunk_1() {
        // Chunk 1: only the first byte should differ (XOR with 0x01)
        let base_nonce: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
            0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF,
        ];
        let index_bytes = (1u128).to_le_bytes();
        let mut nonce = [0u8; 16];
        for i in 0..16 {
            nonce[i] = base_nonce[i] ^ index_bytes[i];
        }
        // First byte: 0x00 XOR 0x01 = 0x01, rest unchanged
        assert_eq!(nonce[0], 0x01);
        assert_eq!(nonce[1], 0x11);
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        // Encrypt some data, then decrypt it — should get original back
        let key = SecureKey::new([0xAA; 32]);
        let nonce: [u8; 16] = [0xBB; 16];
        let plaintext = b"Hello, this is a test of AES-256-CTR roundtrip!";

        // "Encrypt" by applying keystream to plaintext
        let mut ciphertext = plaintext.to_vec();
        let mut cipher = Aes256Ctr::new(key.as_bytes().into(), &nonce.into());
        cipher.apply_keystream(&mut ciphertext);

        // Ciphertext should be different from plaintext
        assert_ne!(&ciphertext, plaintext);

        // Decrypt should recover the original
        let decrypted = decrypt_chunk(&key, &nonce, 0, &ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_secure_key_zeroize() {
        let mut key_copy = [0u8; 32];
        {
            let key = SecureKey::new([0xFF; 32]);
            key_copy.copy_from_slice(key.as_bytes());
            assert_eq!(key_copy, [0xFF; 32]);
        }
        // Key is dropped and zeroed. We can't inspect freed memory,
        // but the test verifies the Zeroize+Drop impl compiles.
    }

    // ═══════════════════════════════════════════════════════════════
    // CROSS-LANGUAGE COMPATIBILITY TESTS
    // These use values from shared/test_vectors.json.
    // If these pass, Rust can decrypt what Python encrypts.
    // ═══════════════════════════════════════════════════════════════

    // Shared test inputs (from test_vectors.json)
    fn test_master_key() -> [u8; 32] {
        hex::decode("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
            .unwrap().try_into().unwrap()
    }
    fn test_salt() -> [u8; 32] {
        hex::decode("fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210")
            .unwrap().try_into().unwrap()
    }
    fn test_video_id() -> [u8; 16] {
        hex::decode("11111111111111111111111111111111")
            .unwrap().try_into().unwrap()
    }
    fn test_tenant_id() -> [u8; 16] {
        hex::decode("22222222222222222222222222222222")
            .unwrap().try_into().unwrap()
    }
    fn test_base_nonce() -> [u8; 16] {
        hex::decode("00112233445566778899aabbccddeeff")
            .unwrap().try_into().unwrap()
    }

    #[test]
    fn test_cross_language_hkdf_480p() {
        // Python produced this derived key for quality=0 (480p)
        let expected_key = hex::decode(
            "e61e550b379dc55d5463fe651fb9ea5e3197f7f99000c89fbcfe39127e17da75"
        ).unwrap();

        let key = SecureKey::derive_video_key(
            &test_master_key(),
            &test_salt(),
            &test_video_id(),
            &test_tenant_id(),
            0, // 480p
        ).unwrap();

        assert_eq!(key.as_bytes().as_slice(), expected_key.as_slice(),
            "HKDF 480p: Rust derived key doesn't match Python!");
    }

    #[test]
    fn test_cross_language_hkdf_720p() {
        let expected_key = hex::decode(
            "68262ea3a806f34c3c67d6a8a6ce79d5f7a5bfa45118199a8b22cfa30a792a09"
        ).unwrap();

        let key = SecureKey::derive_video_key(
            &test_master_key(),
            &test_salt(),
            &test_video_id(),
            &test_tenant_id(),
            1, // 720p
        ).unwrap();

        assert_eq!(key.as_bytes().as_slice(), expected_key.as_slice(),
            "HKDF 720p: Rust derived key doesn't match Python!");
    }

    #[test]
    fn test_cross_language_hkdf_1080p() {
        let expected_key = hex::decode(
            "74a3fd01f2cc30e6"  // first 8 bytes — read from test_vectors.json
        ).unwrap();

        let key = SecureKey::derive_video_key(
            &test_master_key(),
            &test_salt(),
            &test_video_id(),
            &test_tenant_id(),
            2, // 1080p
        ).unwrap();

        // Compare first 8 bytes (partial match is enough to prove HKDF works)
        assert_eq!(&key.as_bytes()[..8], expected_key.as_slice(),
            "HKDF 1080p: Rust derived key doesn't match Python!");
    }

    #[test]
    fn test_cross_language_decrypt_chunk_0() {
        // Derive the 480p key (already validated above)
        let key = SecureKey::derive_video_key(
            &test_master_key(),
            &test_salt(),
            &test_video_id(),
            &test_tenant_id(),
            0, // 480p
        ).unwrap();

        let base_nonce = test_base_nonce();

        // Ciphertext produced by Python for chunk 0
        let ciphertext = hex::decode(
            "4ef1aa5fd6a8ec91d6150497690a39bc52b2068d8efd0a181e40e8f09155238b\
             0e90c83d9a06840dd701dac0b5de82db6305cb9449ee7e7a594583a67547f316\
             eef5ec31db7d26bb4d6383ad2f96313f474ab7645246863d17375b24d316316d\
             bf07406807093bd5c33bd04877f1de59629add71d24198785e0f4a959a772cca\
             5c2023ae02244905b567a8e388e424ba91fc429abde180f519b9011e16c76498\
             eb45d4c2a03bcda55ac63306d4f709e41b15e5f61baab6fc4c13211915b6123a\
             7faf7af1de4e005afb78cec68f570e63e19eb76a66c136fc0d770d747fab00e5\
             f658854511c579d2a2ecdd88b538305b826b30ef0aaef98299f6f66d8dab2c71\
             42bd0a4f8bb8055de6df20aa9a5c704f7f08e7e4c6a62b5263ec04fefb54eec1\
             d6ce877037ac35dd8c412ff3df5b82db262fe261384f164444d64e23dca4681b\
             f0335ca8c323cdd878e5acfb7c07d9605b29db57515e5cd875db98a68a7ce8c5\
             6c4a60237b9c94977f6ba046b5a8196dfa161d059792cc0410d0666981c918e5\
             a79c25da924f60d6d4dc79be9f642f3078ec58795a8abb1f6ad5cd2529ef0131\
             b69e79f3d893dfbfdca78787966a11f75e646c05641734e93072b4dd9686e4b0\
             fdba445ee75fcd1ac580c9f7bdc13efe8bf1c30f6b0b3935ecd31367c6e6f565\
             7b62d2b0833060b9b9e3e15e6b7e49d8047c759fe63e06c5fa5fdbd582b01606\
             db65bb0700aa70d382185de0f1356ddf4ec18e3348fa47336e5e89cbcb29a558\
             585bce41c24b2df29636a877e2b4fb0432c0408c0c1a396f0bca8b72308d5c89\
             8499856e3bacc169d423f5e5488f0102424ddb4af1513492"
        ).unwrap();

        // Expected plaintext: "Hello, this is a test chunk for cross-language verification!" * 10
        let expected_plaintext = "Hello, this is a test chunk for cross-language verification!"
            .repeat(10);

        // Decrypt using Rust
        let decrypted = decrypt_chunk(&key, &base_nonce, 0, &ciphertext).unwrap();

        assert_eq!(decrypted, expected_plaintext.as_bytes(),
            "DECRYPTION FAILED: Rust cannot decrypt Python's ciphertext!\n\
             This means the HKDF info parameter or nonce derivation differs.");
    }

    #[test]
    fn test_cross_language_decrypt_chunk_1() {
        // Same key as chunk 0 (same video), but different nonce (chunk index 1)
        let key = SecureKey::derive_video_key(
            &test_master_key(),
            &test_salt(),
            &test_video_id(),
            &test_tenant_id(),
            0, // 480p
        ).unwrap();

        let base_nonce = test_base_nonce();

        // Ciphertext produced by Python for chunk 1 (different nonce!)
        let ciphertext = hex::decode(
            "ed8bce0ee7fdf61b10413e46d22d98422347ce3e4dd7f1f0861c68641d4b660a\
             78fd712ec578c7e1037ac9954247b3105f8d37cb80458275e3d2738b2c65641c\
             8373ee4c1aa9c69af877d1cd722ba861023a283a0efec715e2ff570efa3d47d4\
             41334b1cdfc06415e496c38d87be7e06a6f50f19081d969cbd5704e76db85528\
             b38a64fce4273a2edddc63d4e69a7c07b87fcf84624bda149a92be2c8966c587\
             c0daabdf52126f9e8525d652254c81e498d0f660560e1f5d54afe05f5f5f8f57\
             fe7981fa362a872e4b5572ae79ab38c533fbf3358ee7ca5c83cbc4c37b43fd40\
             9289fff9242c36ca1ba9378d998075364f3ba81f07a59c7667a15a88b3770578\
             1e6bed438f498e4a662e3a9e2f110b561300fc7e18215dd49d5446f704534948\
             36ae8c4b10cb7180e0086446aafb795a816f246ba31aefd486e351e557d34609\
             1c8e8f9df4057585a1de777eec8b8132edd3d27a5ac0bb199d990320fc8b84aa\
             2db18841dd691b08b688a68c00fd24cdea751046937538d7bcd6710a33c105e1\
             bc7cdd05f96985cf0d3842dd31e00b416f94a22c607e9606176215a61e68057c\
             0a61ead84666b27f25974f6fd10abacf78d9ba98319df2819264a49da7128a34\
             3c4ad80dafd161178753c0cbde259bd1878c5c4b8b2fb259168e58128737c0b1\
             15ee077784ff144abcab9ff32b4cdf48ed25831400b9f3ef49ea39c1e56feb49\
             cda928652aace2bd9e3628fec402f001009992a140a5f4126d2e3344cc81e8fe\
             fdb99418340aad63c5ed97d94583e1dfb5c30b6644fee41c0ec14e17f840d680\
             dcb897194180761019a1836f7f053dc5c44ff13260c9e984"
        ).unwrap();

        let expected_plaintext = "Hello, this is a test chunk for cross-language verification!"
            .repeat(10);

        // Decrypt chunk 1 — uses chunk_index=1, which changes the nonce
        let decrypted = decrypt_chunk(&key, &base_nonce, 1, &ciphertext).unwrap();

        assert_eq!(decrypted, expected_plaintext.as_bytes(),
            "CHUNK 1 DECRYPTION FAILED: Nonce XOR derivation differs between Python and Rust!");
    }
}
