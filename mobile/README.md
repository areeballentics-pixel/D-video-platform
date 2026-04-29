# SVP Mobile Player

React Native player for the Secure Video Platform. Single TypeScript codebase
for Android + iOS; native video modules behind a common JS interface
(`SvpVideoPlayer`).

## Stack

| Layer | Tech |
|---|---|
| UI / navigation / business logic | React Native 0.76 + TypeScript + React Navigation v7 |
| State | Zustand |
| Token + secure storage | `react-native-keychain` (OS keychain) |
| Course / video cache | `react-native-mmkv` |
| Decryption | Native module → JNI / Swift FFI → `svf-core` Rust crate |
| Playback | ExoPlayer (Android) / AVPlayer (iOS), both with custom byte-range data source |

## Native modules

This scaffolding ships only the JS/TS side. The native video modules are
built in tasks #9 (Android Kotlin) and #10 (iOS Swift). Until they're in:

- `src/native/SvpVideoPlayer.ts` declares the TS interface the modules must
  implement. `PlayerScreen.tsx` falls back to a "native module not yet
  installed" placeholder when the module is missing.

## First-time setup (after cloning)

The full `android/` and `ios/` folders aren't committed — they're generated
once via the React Native CLI:

```bash
# 1. Install JS deps
cd mobile
npm install

# 2. Generate native projects (one-time; commit the result)
npx @react-native-community/cli init SvpMobile \
    --template react-native@0.76.5 \
    --skip-install \
    --skip-git-init
mv SvpMobile/android .
mv SvpMobile/ios .
rm -rf SvpMobile

# 3. iOS pods (Mac only)
cd ios && pod install && cd ..

# 4. Run
npm run android   # opens Metro + builds APK + installs on connected device
npm run ios       # opens Metro + builds IPA + launches on simulator
```

## Verifying the JS layer

```bash
npm run typecheck
```

This runs `tsc --noEmit` against `src/`. If it passes, the shared JS layer
is consistent — the native modules then just need to match the
`SvpVideoPlayer` interface in `src/native/`.

## Environment

`SVP_SERVER_URL` is read at bundle time:

```bash
SVP_SERVER_URL=https://api.yourplatform.com npm run android
```

Falls back to `http://10.0.2.2:8000` on Android emulators (host loopback)
and `http://localhost:8000` on iOS simulators.

## Anti-piracy notes

- Android: `FLAG_SECURE` set on the player Activity (Task #9) blocks system
  screenshots + most third-party recorders.
- iOS: `UIScreen.isCaptured` observer pauses playback whenever a screen
  recording is detected (Task #10).
- Both: root/jailbreak detection refuses playback. Watermark overlay
  (`src/components/WatermarkOverlay.tsx`) renders student email + truncated
  license key, randomized position every 30 s.
- Decrypted bytes never written to disk — the custom `DataSource` decrypts
  chunks in memory and feeds them straight to the platform demuxer.
