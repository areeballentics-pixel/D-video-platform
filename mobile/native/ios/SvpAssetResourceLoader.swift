import AVFoundation
import Foundation

/// Custom AVAssetResourceLoaderDelegate that decrypts SVF chunks on demand.
///
/// Pattern: register a custom URL scheme (e.g. `svp://`) on an AVURLAsset,
/// and AVPlayer will route every byte-range request through this delegate.
/// We translate the requested byte range into "decrypt chunks N..M and
/// slice into them", returning plaintext bytes. Decrypted bytes never
/// touch the file system — they live in `Data` until AVPlayer's demuxer
/// has consumed them, then are freed.
final class SvpAssetResourceLoader: NSObject, AVAssetResourceLoaderDelegate {

    private let svfPath: String
    private let masterKey: [UInt8]

    private var handle: SvpHandle?
    private var header: SvpHeaderInfo?

    /// Cached decrypted plaintext for the chunk we last served. Re-used across
    /// adjacent byte-range requests to avoid re-decrypting.
    private var cachedChunkIndex: UInt32 = .max
    private var cachedChunkData: Data?

    init(svfPath: String, masterKey: [UInt8]) {
        precondition(masterKey.count == 32, "master key must be 32 bytes")
        self.svfPath = svfPath
        self.masterKey = masterKey
        super.init()
    }

    deinit {
        // Wipe master key when the loader is freed.
        cachedChunkData?.resetBytes(in: 0..<(cachedChunkData?.count ?? 0))
        handle?.close()
    }

    // MARK: - AVAssetResourceLoaderDelegate

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        shouldWaitForLoadingOfRequestedResource req: AVAssetResourceLoadingRequest
    ) -> Bool {
        do {
            // Lazy-open on first request (avoids opening a handle that might
            // never be used if the asset is cancelled before play).
            if handle == nil {
                handle = try SvpHandle.open(path: svfPath)
            }
            if header == nil {
                header = try handle?.header()
            }
            guard let h = handle, let hdr = header else {
                req.finishLoading(with: SvpFfiError.openFailed)
                return true
            }

            // Respond to content-info requests so AVPlayer knows the size
            // and that byte-range requests are supported.
            if let info = req.contentInformationRequest {
                info.contentType = "public.mpeg-4"
                info.contentLength = Int64(hdr.original_size)
                info.isByteRangeAccessSupported = true
            }

            if let data = req.dataRequest {
                let requestedOffset = data.requestedOffset
                let requestedLength = data.requestedLength

                let chunkSize = Int64(hdr.chunk_size)
                var remaining = Int64(requestedLength)
                var cursor = requestedOffset

                while remaining > 0 {
                    let chunkIndex = UInt32(cursor / chunkSize)
                    let withinChunk = Int(cursor % chunkSize)

                    let plaintext: Data
                    if cachedChunkIndex == chunkIndex, let cached = cachedChunkData {
                        plaintext = cached
                    } else {
                        plaintext = try h.decryptChunk(
                            index: chunkIndex,
                            masterKey: masterKey
                        )
                        // Wipe the previous cache before caching the new one.
                        cachedChunkData?.resetBytes(in: 0..<(cachedChunkData?.count ?? 0))
                        cachedChunkData = plaintext
                        cachedChunkIndex = chunkIndex
                    }

                    let available = plaintext.count - withinChunk
                    if available <= 0 { break }
                    let toCopy = Swift.min(Int(remaining), available)
                    let slice = plaintext.subdata(in: withinChunk..<(withinChunk + toCopy))
                    data.respond(with: slice)

                    remaining -= Int64(toCopy)
                    cursor += Int64(toCopy)
                }

                req.finishLoading()
            }
        } catch {
            req.finishLoading(with: error)
        }
        return true
    }
}
