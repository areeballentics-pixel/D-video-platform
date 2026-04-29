import Foundation

/// Swift wrappers around the svf-core-ffi C ABI. The functions themselves are
/// declared in `SvpVideoPlayer-Bridging-Header.h`; this file makes them more
/// idiomatic to call from Swift (Optional handles, throws on error).

enum SvpFfiError: Error {
    case openFailed
    case headerFailed
    case unknownHandle
    case badMasterKey
    case chunkOutOfRange
    case chunkHashMismatch
    case decryptError
    case bufferTooSmall

    init(code: Int) {
        switch code {
        case -1: self = .unknownHandle
        case -2: self = .badMasterKey
        case -3: self = .chunkOutOfRange
        case -4: self = .chunkHashMismatch
        case -5: self = .decryptError
        case -6: self = .bufferTooSmall
        default: self = .decryptError
        }
    }
}


struct SvpHandle {
    let raw: Int64

    static func open(path: String) throws -> SvpHandle {
        let h = path.withCString { svp_open($0) }
        if h == 0 { throw SvpFfiError.openFailed }
        return SvpHandle(raw: h)
    }

    func header() throws -> SvpHeaderInfo {
        var info = SvpHeaderInfo()
        let rc = svp_header(raw, &info)
        if rc == 0 { throw SvpFfiError.headerFailed }
        return info
    }

    func decryptChunk(index: UInt32, masterKey: [UInt8]) throws -> Data {
        precondition(masterKey.count == 32, "master key must be 32 bytes")

        // Chunks are at most chunk_size bytes; we don't know it without
        // having read the header. The caller passes in the buffer size to
        // avoid an extra allocation. For typical chunk_size = 1 MiB, we
        // allocate 1 MiB + a small safety margin.
        let info = try header()
        var out = [UInt8](repeating: 0, count: Int(info.chunk_size) + 32)

        let written = masterKey.withUnsafeBufferPointer { mk in
            out.withUnsafeMutableBufferPointer { buf in
                svp_decrypt_chunk(
                    raw,
                    index,
                    mk.baseAddress,
                    mk.count,
                    buf.baseAddress,
                    buf.count
                )
            }
        }
        if written < 0 {
            throw SvpFfiError(code: Int(written))
        }
        return Data(out.prefix(Int(written)))
    }

    func close() {
        svp_close(raw)
    }
}


/// Initialize Rust-side logging once at app launch. Idempotent.
func svpInitLogging() {
    svp_init_logging()
}
