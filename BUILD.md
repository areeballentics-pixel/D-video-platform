# Build & Distribution

End-to-end build instructions for every distributable artifact.

## Components

| Artifact | Tooling | Output |
|---|---|---|
| Server (Docker image) | `docker compose build` | `svp-api:latest` |
| Encryptor (Win) | `cargo tauri build` | `SVPEncryptor_<v>_x64_en-US.msi` |
| Encryptor (macOS) | `cargo tauri build --target {x86_64,aarch64}-apple-darwin` | `SVPEncryptor_<v>.dmg` |
| Encryptor (Linux) | `cargo tauri build --bundles deb,appimage` | `.deb` + `.AppImage` |
| Player (Win) | `cargo tauri build` (in `player/`) | `SecurePlayer_<v>_x64_en-US.msi` |
| Android APK | `cd mobile && npm run android -- --variant=release` | `app-release.apk` |
| iOS IPA | Xcode → Product → Archive → Distribute App | `.ipa` |

## One-time setup

### Windows builds (encryptor + player)

```powershell
# Rust toolchain — install once
rustup default stable
rustup target add x86_64-pc-windows-msvc

# Install Tauri CLI
cargo install tauri-cli --version "^2.0"

# Visual Studio C++ Build Tools (required by tauri-build)
# Download from https://aka.ms/vs/17/release/vs_BuildTools.exe
```

### macOS builds (encryptor + player)

```bash
brew install rust
rustup target add x86_64-apple-darwin aarch64-apple-darwin
cargo install tauri-cli --version "^2.0"

# Optional — only needed for App Store / Gatekeeper notarization:
# Apple Developer Program ($99/yr)
# xcrun altool --notarize-app ...
```

### Linux builds (encryptor + player)

```bash
sudo apt install -y \
    libwebkit2gtk-4.1-dev \
    libssl-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    build-essential
cargo install tauri-cli --version "^2.0"
```

### Android (mobile)

```bash
# Android Studio with SDK + NDK
# In Android Studio: Tools → SDK Manager → SDK Tools → NDK (Side by side)

# Cargo NDK + targets
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
cargo install cargo-ndk
```

### iOS (mobile, Mac only)

```bash
# Xcode 16+
# Apple Developer Program account (for signing)

rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

cd mobile
npx pod-install
```

## Build commands

### Server image

```bash
docker compose -f docker-compose.prod.yml build server
docker tag svp-api:latest <your-registry>/svp-api:latest
docker push <your-registry>/svp-api:latest
```

### Encryptor (Windows)

```powershell
cd encryptor
$env:SVP_SERVER_URL = "https://api.yourplatform.com"
npm install
npm run tauri build
# Output: encryptor/src-tauri/target/release/bundle/msi/*.msi
```

### Encryptor (macOS universal)

```bash
cd encryptor
SVP_SERVER_URL=https://api.yourplatform.com npm install
SVP_SERVER_URL=https://api.yourplatform.com cargo tauri build --target universal-apple-darwin
# Output: encryptor/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg
```

### Encryptor (Linux)

```bash
cd encryptor
SVP_SERVER_URL=https://api.yourplatform.com npm install
SVP_SERVER_URL=https://api.yourplatform.com cargo tauri build
# Output: encryptor/src-tauri/target/release/bundle/{deb,appimage}/*.{deb,AppImage}
```

### Player (Windows / macOS / Linux)

Same commands as encryptor, but in the `player/` directory.

### Android APK (release)

```bash
# 1. Build the Rust .so files for all 3 ABIs
cd crates/svf-core-jni
cargo ndk \
    -t arm64-v8a \
    -t armeabi-v7a \
    -t x86_64 \
    -o ../../mobile/android/app/src/main/jniLibs \
    build --release

# 2. Build the signed APK
cd ../../mobile
SVP_SERVER_URL=https://api.yourplatform.com \
    npx react-native run-android --variant=release
# Output: mobile/android/app/build/outputs/apk/release/app-release.apk
```

For a release-signed APK you need a keystore — see
`mobile/android/app/build.gradle` for `signingConfigs`. Don't commit the
keystore; pin its path via `MYAPP_UPLOAD_STORE_FILE` and friends in your
CI environment.

### iOS IPA (release, Mac only)

```bash
# 1. Build the Rust xcframework
cd crates/svf-core-ffi
cargo build --release --target aarch64-apple-ios
cargo build --release --target aarch64-apple-ios-sim
cargo build --release --target x86_64-apple-ios
mkdir -p target/sim
lipo -create \
    target/aarch64-apple-ios-sim/release/libsvf_core_ffi.a \
    target/x86_64-apple-ios/release/libsvf_core_ffi.a \
    -output target/sim/libsvf_core_ffi.a
xcodebuild -create-xcframework \
    -library target/aarch64-apple-ios/release/libsvf_core_ffi.a \
    -library target/sim/libsvf_core_ffi.a \
    -output ../../mobile/ios/svf-core/svf-core.xcframework

# 2. Open in Xcode
cd ../../mobile/ios
open SvpMobile.xcworkspace
# Product → Scheme → Edit Scheme → Run → Build Configuration: Release
# Product → Archive → Distribute App → App Store Connect / Ad Hoc
```

## Auto-updater

The encryptor app polls `GET /api/encryptor/latest` on launch (Tauri 2's
built-in updater). To publish a new version:

1. Build the new `.msi` / `.dmg` / `.AppImage`.
2. Sign it with your Tauri minisign key (one-time generated via
   `cargo tauri signer generate`).
3. Upload the artifacts to your CDN / S3 / GitHub Releases.
4. Set the server's `ENCRYPTOR_LATEST_JSON` env var to the new manifest:

```bash
ENCRYPTOR_LATEST_JSON='{"version":"0.2.0","notes":"...","pub_date":"2026-05-01T00:00:00Z","platforms":{"windows-x86_64":{"signature":"...","url":"https://your-cdn/SVPEncryptor_0.2.0_x64_en-US.msi"}}}'
```

Or write the same JSON to `/etc/svp/encryptor-latest.json` on the API host.

The encryptor will pick up the new version on its next launch.

## Distribution (initial)

| Channel | Artifact | Audience |
|---|---|---|
| Direct download from your site | Encryptor `.msi` / `.dmg` / `.AppImage` | Tenant admins |
| Direct download from your site | Player `.msi` / `.dmg` / `.AppImage` | Students (one-time install) |
| Google Play (internal testing → production) | Android APK / AAB | Students |
| TestFlight → App Store | iOS IPA | Students |
| Docker registry | Server image | You |
