package com.svp.player

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import java.io.IOException
import java.nio.ByteBuffer

/**
 * Custom ExoPlayer DataSource that lazily decrypts SVF chunks on demand.
 *
 * ExoPlayer asks our DataSource for byte ranges of what it thinks is a
 * normal MP4 file. We translate "give me bytes [100_000, 110_000)" into
 * "decrypt chunks 0 and 1 (since chunk_size = 1 MiB), then slice into them
 * to return exactly that range".
 *
 * Critically: decrypted bytes never touch disk. They live briefly in the
 * `chunkCache` ByteArray + ExoPlayer's internal buffer, then ExoPlayer
 * passes them straight to the demuxer.
 */
class SvpDataSource(
    private val svfPath: String,
    private val masterKey: ByteArray,
) : BaseDataSource(/* isNetwork= */ false), DataSource {

    /** Header layout offsets — keep in lock-step with crates/svf-core-jni/src/lib.rs */
    private data class Header(
        val chunkSize: Int,
        val chunkCount: Int,
        val originalSize: Long,
    )

    private var handle: Long = 0L
    private var header: Header? = null

    private var bytesRemaining: Long = 0L
    private var positionInOriginal: Long = 0L

    /** Decrypted plaintext for the chunk we're currently serving. */
    private var chunkBuffer: ByteArray? = null
    private var chunkBaseOffset: Long = 0L
    private var chunkLoaded: Int = -1

    private var openedUri: Uri? = null

    override fun open(dataSpec: DataSpec): Long {
        transferInitializing(dataSpec)

        if (handle == 0L) {
            handle = RustBindings.nativeOpenSvf(svfPath)
            if (handle == 0L) {
                throw IOException("Failed to open .svf at $svfPath")
            }
            val raw = RustBindings.nativeGetHeader(handle)
                ?: throw IOException("nativeGetHeader returned null")
            // See RustBindings.kt for the exact byte layout.
            val bb = ByteBuffer.wrap(raw).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            // Skip video_id, tenant_id, salt, nonce → 16+16+32+16 = 80 bytes.
            bb.position(80)
            val quality = bb.short.toInt() and 0xFFFF
            val chunkSize = bb.int
            val chunkCount = bb.int
            val durationMs = bb.long
            val width = bb.int
            val height = bb.int
            // Content hash + original_size at known offsets.
            bb.position(106)
            val contentHash = ByteArray(32).also { bb.get(it) }
            val originalSize = bb.long
            header = Header(chunkSize, chunkCount, originalSize)

            // Suppress lint warnings on unused locals — we keep them around
            // for future use (analytics, deeper integrity checks).
            @Suppress("UNUSED_VARIABLE") val _q = quality
            @Suppress("UNUSED_VARIABLE") val _d = durationMs
            @Suppress("UNUSED_VARIABLE") val _w = width
            @Suppress("UNUSED_VARIABLE") val _h = height
            @Suppress("UNUSED_VARIABLE") val _ch = contentHash
        }

        val h = header ?: throw IOException("header parse failed")
        positionInOriginal = dataSpec.position.coerceAtLeast(0L)
        bytesRemaining = if (dataSpec.length == C.LENGTH_UNSET.toLong()) {
            (h.originalSize - positionInOriginal).coerceAtLeast(0L)
        } else {
            dataSpec.length
        }

        openedUri = dataSpec.uri
        transferStarted(dataSpec)
        return bytesRemaining
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (bytesRemaining == 0L) return C.RESULT_END_OF_INPUT
        val want = length.toLong().coerceAtMost(bytesRemaining).toInt()
        if (want == 0) return 0

        val h = header ?: throw IOException("not opened")
        val targetChunk = (positionInOriginal / h.chunkSize).toInt()
        val withinChunk = (positionInOriginal % h.chunkSize).toInt()

        if (chunkLoaded != targetChunk) {
            // Decrypt the chunk lazily. Only the chunk currently being served
            // sits in memory; previous chunks are dropped on the next request.
            val plain = RustBindings.nativeDecryptChunk(handle, targetChunk, masterKey)
                ?: throw IOException("Decrypt failed for chunk $targetChunk")
            chunkBuffer = plain
            chunkBaseOffset = targetChunk.toLong() * h.chunkSize
            chunkLoaded = targetChunk
        }

        val cb = chunkBuffer ?: throw IOException("chunk buffer null")
        val available = cb.size - withinChunk
        val toCopy = want.coerceAtMost(available)
        if (toCopy <= 0) {
            // Should be unreachable for a well-formed file, but defensive.
            return C.RESULT_END_OF_INPUT
        }
        System.arraycopy(cb, withinChunk, buffer, offset, toCopy)

        positionInOriginal += toCopy
        bytesRemaining -= toCopy
        bytesTransferred(toCopy)
        return toCopy
    }

    override fun getUri(): Uri? = openedUri

    override fun close() {
        try {
            if (handle != 0L) {
                RustBindings.nativeClose(handle)
            }
        } finally {
            handle = 0L
            // Wipe the in-memory plaintext before releasing — defense in depth
            // against the JVM not zeroing the array immediately on GC.
            chunkBuffer?.fill(0)
            chunkBuffer = null
            // Also wipe the master key copy we held. The caller owns the
            // canonical copy; this is just our local view.
            masterKey.fill(0)
            transferEnded()
            openedUri = null
        }
    }

    /** Factory for use with ExoPlayer's MediaSource builders. */
    class Factory(
        private val svfPath: String,
        private val masterKey: ByteArray,
    ) : DataSource.Factory {
        override fun createDataSource(): DataSource = SvpDataSource(svfPath, masterKey)

        // RN modules don't always have a pluggable transfer listener — leave
        // unimplemented; ExoPlayer is happy without one.
        @Suppress("UNUSED_PARAMETER")
        fun setTransferListener(transferListener: TransferListener?): Factory = this
    }
}
