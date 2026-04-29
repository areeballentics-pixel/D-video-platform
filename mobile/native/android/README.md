# Android native video module

Kotlin sources for the SVP player's Android native module. Copy into
`mobile/android/app/src/main/kotlin/com/svp/player/` once the `android/`
folder is generated (see `mobile/README.md`).

## Files

| File | Purpose |
|---|---|
| `RustBindings.kt` | JNI declarations + `System.loadLibrary("svf_core_jni")` |
| `SvpDataSource.kt` | Custom ExoPlayer `DataSource` that decrypts byte-range reads on demand |
| `SvpVideoPlayerModule.kt` | React Native module: `play`, `pause`, `seek`, `runSecurityChecks`, etc. |
| `SvpVideoPlayerPackage.kt` | Registers the module with the host RN app |
| `SecurityChecks.kt` | Root / Magisk / emulator detection |

## Building the .so

The `svf_core_jni` Rust crate at `crates/svf-core-jni/` compiles to a per-ABI
shared library that lives in `mobile/android/app/src/main/jniLibs/`.

### One-time setup

```bash
# 1. Install Rust Android targets
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

# 2. Install cargo-ndk (auto-handles NDK linker setup)
cargo install cargo-ndk
```

### Build (run from repo root)

```bash
cd crates/svf-core-jni
cargo ndk \
    -t arm64-v8a \
    -t armeabi-v7a \
    -t x86_64 \
    -o ../../mobile/android/app/src/main/jniLibs \
    build --release
```

Output: `mobile/android/app/src/main/jniLibs/{arm64-v8a,armeabi-v7a,x86_64}/libsvf_core_jni.so`.

### Wire into Gradle

In `mobile/android/app/build.gradle`, ensure jniLibs is included:

```groovy
android {
    sourceSets {
        main {
            jniLibs.srcDirs = ['src/main/jniLibs']
        }
    }
}
```

ExoPlayer dependency:

```groovy
dependencies {
    implementation "androidx.media3:media3-exoplayer:1.5.0"
    implementation "androidx.media3:media3-ui:1.5.0"
    implementation "androidx.media3:media3-datasource:1.5.0"
}
```

## Register the package with React Native

In `mobile/android/app/src/main/java/com/svp_mobile/MainApplication.kt`:

```kotlin
override fun getPackages(): List<ReactPackage> =
    PackageList(this).packages.apply {
        add(SvpVideoPlayerPackage())  // ← add this line
    }
```

## Anti-piracy

- `FLAG_SECURE` is set on the host Activity in `SvpVideoPlayerModule.play()`
  via `getCurrentActivity().window.setFlags(FLAG_SECURE, FLAG_SECURE)`.
  System-level screenshots and most third-party recorders are blocked.
- Root detection (`SecurityChecks.isDeviceRooted()`) refuses playback when
  Magisk, SuperSU, or common root binaries are detected.
- Emulator detection (`Build.FINGERPRINT` patterns + missing telephony)
  refuses playback on common emulators. Real devices pass.
