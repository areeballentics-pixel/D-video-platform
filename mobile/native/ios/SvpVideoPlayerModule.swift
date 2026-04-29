import AVFoundation
import AVKit
import Foundation
import React
import UIKit

/// React Native bridge for the SVF player on iOS. Implements the
/// `SvpVideoPlayer` TS interface from mobile/src/native/SvpVideoPlayer.ts.
///
/// At most one active AVPlayer at a time. The host RN app's root view is
/// used as the container; a future v1.1 enhancement will introduce a
/// dedicated `<SvpPlayerView />` Component for inline playback.
@objc(SvpVideoPlayer)
final class SvpVideoPlayerModule: NSObject {

    private var player: AVPlayer?
    private var resourceLoader: SvpAssetResourceLoader?
    private var screenCaptureObserver: NSObjectProtocol?
    private let queue = DispatchQueue(label: "com.svp.player.resourceLoader")

    @objc static func requiresMainQueueSetup() -> Bool { true }

    @objc func isReady(_ resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: RCTPromiseRejectBlock) {
        // FFI is statically linked; calling svp_init_logging here is the
        // earliest moment the .a is guaranteed loaded.
        svpInitLogging()
        resolve(true)
    }

    @objc func play(_ params: NSDictionary,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let svfPath = params["svfPath"] as? String,
              let keyHex = params["keyHex"] as? String else {
            reject("invalid_params", "svfPath and keyHex required", nil)
            return
        }
        let masterKey: [UInt8]
        do {
            masterKey = try hexDecode(keyHex)
        } catch {
            reject("bad_key", "invalid hex", error)
            return
        }
        guard masterKey.count == 32 else {
            reject("bad_key", "master key must be 32 bytes", nil)
            return
        }

        DispatchQueue.main.async {
            self.tearDown()

            let loader = SvpAssetResourceLoader(svfPath: svfPath, masterKey: masterKey)
            self.resourceLoader = loader

            // Register a custom scheme so AVPlayer routes byte-range requests
            // through our resource loader.
            guard let url = URL(string: "svp://current") else {
                reject("bad_url", "couldn't build svp:// URL", nil)
                return
            }
            let asset = AVURLAsset(url: url, options: nil)
            asset.resourceLoader.setDelegate(loader, queue: self.queue)

            let item = AVPlayerItem(asset: asset)
            let player = AVPlayer(playerItem: item)
            self.player = player

            // Start observing screen capture so we can pause playback the
            // moment a recording is detected.
            self.screenCaptureObserver = NotificationCenter.default.addObserver(
                forName: UIScreen.capturedDidChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                if UIScreen.main.isCaptured {
                    self?.player?.pause()
                }
            }

            player.play()

            // Resolve immediately; duration may not be loaded yet. JS-side
            // listeners can subscribe to playback events for richer state.
            resolve(["duration_ms": 0])
        }
    }

    @objc func pause(_ resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            self.player?.pause()
            resolve(nil)
        }
    }

    @objc func resume(_ resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            self.player?.play()
            resolve(nil)
        }
    }

    @objc func seek(_ positionMs: NSNumber,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            let t = CMTime(value: Int64(positionMs.doubleValue), timescale: 1000)
            self.player?.seek(to: t)
            resolve(nil)
        }
    }

    @objc func stop(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            self.tearDown()
            resolve(nil)
        }
    }

    @objc func getPosition(_ resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            let ms = (self.player?.currentTime().seconds ?? 0.0) * 1000.0
            resolve(NSNumber(value: ms))
        }
    }

    @objc func runSecurityChecks(_ resolve: @escaping RCTPromiseResolveBlock,
                                 rejecter reject: RCTPromiseRejectBlock) {
        resolve(SecurityChecks.runAll())
    }

    // MARK: - Helpers

    private func tearDown() {
        player?.pause()
        player = nil
        resourceLoader = nil
        if let obs = screenCaptureObserver {
            NotificationCenter.default.removeObserver(obs)
            screenCaptureObserver = nil
        }
    }

    private func hexDecode(_ s: String) throws -> [UInt8] {
        guard s.count % 2 == 0 else {
            throw NSError(domain: "svp", code: 1, userInfo: nil)
        }
        var out = [UInt8]()
        out.reserveCapacity(s.count / 2)
        var iter = s.unicodeScalars.makeIterator()
        while let hi = iter.next(), let lo = iter.next() {
            guard let h = hexDigit(hi), let l = hexDigit(lo) else {
                throw NSError(domain: "svp", code: 1, userInfo: nil)
            }
            out.append(UInt8(h * 16 + l))
        }
        return out
    }

    private func hexDigit(_ s: Unicode.Scalar) -> Int? {
        switch s {
        case "0"..."9": return Int(s.value - 0x30)
        case "a"..."f": return Int(s.value - 0x61 + 10)
        case "A"..."F": return Int(s.value - 0x41 + 10)
        default: return nil
        }
    }
}
