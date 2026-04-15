"""AES-256-CTR chunk encryption with multi-threading for speed.

Each chunk gets a unique nonce derived from the base nonce:
    chunk_nonce = base_nonce XOR (chunk_index as u128 LE, zero-padded to 16 bytes)

Since each chunk has an independent nonce, chunks can be encrypted
in parallel with no inter-chunk dependency.
"""

import hashlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


@dataclass
class EncryptedChunk:
    """Result of encrypting one chunk."""

    index: int
    data: bytes
    hash: bytes  # SHA-256 of encrypted data


def _derive_chunk_nonce(base_nonce: bytes, chunk_index: int) -> bytes:
    """XOR the base nonce with the chunk index (as u128 LE, zero-padded to 16 bytes)."""
    index_bytes = chunk_index.to_bytes(16, "little")
    return bytes(a ^ b for a, b in zip(base_nonce, index_bytes))


def _encrypt_single_chunk(
    key: bytes, base_nonce: bytes, chunk_index: int, plaintext: bytes
) -> EncryptedChunk:
    """Encrypt a single chunk with AES-256-CTR."""
    nonce = _derive_chunk_nonce(base_nonce, chunk_index)

    cipher = Cipher(algorithms.AES(key), modes.CTR(nonce))
    encryptor = cipher.encryptor()
    ciphertext = encryptor.update(plaintext) + encryptor.finalize()

    chunk_hash = hashlib.sha256(ciphertext).digest()

    return EncryptedChunk(index=chunk_index, data=ciphertext, hash=chunk_hash)


def encrypt_chunks(
    key: bytes,
    base_nonce: bytes,
    chunks: list[bytes],
    max_workers: int | None = None,
) -> list[EncryptedChunk]:
    """
    Encrypt multiple chunks in parallel using a thread pool.

    Args:
        key: 32-byte AES key
        base_nonce: 16-byte base nonce (per-chunk nonce derived from this)
        chunks: List of plaintext chunk data
        max_workers: Number of threads (default: min(cpu_count, len(chunks), 8))

    Returns:
        List of EncryptedChunk in order
    """
    import os

    if max_workers is None:
        max_workers = min(os.cpu_count() or 4, len(chunks), 8)

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            executor.submit(_encrypt_single_chunk, key, base_nonce, i, chunk)
            for i, chunk in enumerate(chunks)
        ]
        results = [f.result() for f in futures]

    # Ensure results are in order
    results.sort(key=lambda r: r.index)
    return results
