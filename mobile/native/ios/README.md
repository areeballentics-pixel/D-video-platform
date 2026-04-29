# iOS native video module

Swift sources for the SVP player's iOS native module. Copy into
`mobile/ios/SvpPlayer/` once the `ios/` folder is generated (see
`mobile/README.md`).

## Files

| File | Purpose |
|---|---|
| `RustBindings.swift` | Swift FFI declarations for the `svf_core_ffi` C ABI |
| `SvpVideoPlayer-Bridging-Header.h` | Exposes the `svp_*` C functions to Swift |
| `SvpAssetResourceLoader.swift` | `AVAssetResourceLoaderDelegate` that decrypts byte-range requests on demand |
| `SvpVideoPlayerModule.swift` | RN module: `play`, `pause`, `seek`, `runSecurityChecks`, etc. |
| `SvpVideoPlayer.m` | Obj-C macro-based RN module registration |
| `SecurityChecks.swift` | Jailbreak detection + `UIScreen.isCaptured` observer |

## Building the xcframework

The `svf_core_ffi` Rust crate at `crates/svf-core-ffi/` compiles to a static
library that we wrap in an `.xcframework` containing slices for device
(`aarch64-apple-ios`) and simulator (`aarch64-apple-ios-sim` +
`x86_64-apple-ios`).

### One-time setup (Mac only)

```bash
# 1. Install Rust iOS targets
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

# 2. Optional: cargo-lipo helps fuse simulator slices into a fat lib.
#    Modern Xcode prefers xcframework over fat .a, so we'll do it manually.
```

### Build (run from repo root)

```bash
cd crates/svf-core-ffi

# Device slice
cargo build --release --target aarch64-apple-ios

# Simulator slices (one per arch, then lipo'd)
cargo build --release --target aarch64-apple-ios-sim
cargo build --release --target x86_64-apple-ios
mkdir -p target/sim
lipo -create \
    target/aarch64-apple-ios-sim/release/libsvf_core_ffi.a \
    target/x86_64-apple-ios/release/libsvf_core_ffi.a \
    -output target/sim/libsvf_core_ffi.a

# Wrap in xcframework
xcodebuild -create-xcframework \
    -library target/aarch64-apple-ios/release/libsvf_core_ffi.a \
    -library target/sim/libsvf_core_ffi.a \
    -output ../../mobile/ios/svf-core/svf-core.xcframework
```

### Wire into Xcode

1. Drag `svf-core.xcframework` into the Xcode project (Frameworks group).
2. Mark "Embed & Sign" on the framework.
3. Add `SvpVideoPlayer-Bridging-Header.h` as the bridging header in target's
   build settings (`SWIFT_OBJC_BRIDGING_HEADER`).
4. Add the Swift + Obj-C source files to the target.

## Anti-piracy

- `UIScreen.main.isCaptured` is observed; when capture starts, the player
  pauses and a "screen recording detected" overlay is shown.
- Jailbreak detection (`SecurityChecks.isJailbroken()`) refuses playback
  when common cydia / unc0ver / checkra1n paths are detected.
- iOS 13+ doesn't allow apps to truly block screen recording (FLAG_SECURE
  has no equivalent). The pause-on-recording observer is the strongest
  available defense; the watermark overlay (RN side) ensures any leaked
  recording carries the student's identifier.
