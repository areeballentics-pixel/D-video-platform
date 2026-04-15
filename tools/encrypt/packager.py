"""SVF packager — assembles the final .svf file from encrypted chunks."""

import hashlib
import struct
from pathlib import Path

from .svf_format import SVF_MAGIC_END, ChunkIndexEntry, SvfHeader


def package_svf(
    header: SvfHeader,
    encrypted_chunks: list,  # list of EncryptedChunk
    output_path: Path,
) -> Path:
    """
    Assemble an .svf file from a header and encrypted chunks.

    Layout:
      [Fixed Header] [Title] [Chunk Index Offset (4B)]
      [Chunk Index Table]
      [Encrypted Chunk Data]
      [File Hash (32B)] [END! magic (4B)]
    """
    # Pack header
    fixed_header = header.pack_fixed()
    title_data = header.pack_title()

    # Calculate offsets
    header_size = len(fixed_header) + len(title_data) + 4  # +4 for chunk_index_offset field
    chunk_index_size = ChunkIndexEntry.ENTRY_SIZE * header.chunk_count
    chunk_index_offset = header_size

    # Chunk data starts after the index table
    data_offset = header_size + chunk_index_size

    # Build chunk index entries with correct offsets
    current_offset = data_offset
    index_entries = []
    for chunk in encrypted_chunks:
        entry = ChunkIndexEntry(
            offset=current_offset,
            encrypted_size=len(chunk.data),
            hash=chunk.hash,
        )
        index_entries.append(entry)
        current_offset += len(chunk.data)

    # Write the file while computing a running hash of all content
    hasher = hashlib.sha256()

    def write_and_hash(f, data: bytes):
        f.write(data)
        hasher.update(data)

    with open(output_path, "wb") as f:
        # Write fixed header
        write_and_hash(f, fixed_header)

        # Write title
        write_and_hash(f, title_data)

        # Write chunk index offset
        write_and_hash(f, struct.pack("<I", chunk_index_offset))

        # Write chunk index table
        for entry in index_entries:
            write_and_hash(f, entry.pack())

        # Write encrypted chunk data
        for chunk in encrypted_chunks:
            write_and_hash(f, chunk.data)

        # Write footer: file hash + end magic
        file_hash = hasher.digest()
        f.write(file_hash)
        f.write(SVF_MAGIC_END)

    return output_path
