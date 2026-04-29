# V1 QA Checklist

Cross-platform verification matrix. The automated parts run via `pytest` +
`cargo test`; the manual parts need real hardware.

## Automated tests (no hardware needed)

| Suite | Command | What it covers |
|---|---|---|
| `svf-core` unit | `cargo test -p svf-core` | Crypto + format roundtrip, **5 cross-language vectors against Python** |
| `svf-core-jni` | `cargo check -p svf-core-jni` | JNI signatures compile (Android cross-build runs in Task #13's pipeline) |
| `svf-core-ffi` | `cargo check -p svf-core-ffi` | C ABI compiles |
| `svp-encryptor` | `cargo test -p svp-encryptor --lib` | **End-to-end pipeline test**: arbitrary input → encrypt → SvfFile parser → SHA-256 match |
| `secure-video-player` | `cargo test -p secure-video-player --lib` | Real .svf decrypt + chunk-hash verification + range parsing |
| Server v1 e2e | `pytest server/tests/test_v1_e2e.py -v` | **Full server flow**: bootstrap → encryptor → course → enrollment → student `/key` → analytics |
| Tenant dashboard build | `cd dashboard && npm run build` | TypeScript clean, Next.js statically generates all routes |
| Master dashboard build | `cd master-dashboard && npm run build` | Same for master |
| Encryptor frontend build | `cd encryptor && npm run build` | TypeScript clean, Vite bundles |
| Mobile typecheck | `cd mobile && npm run typecheck` | RN screens + native module spec |

### Run all automated tests

```bash
# Workspace Rust
cargo test --workspace

# Server (postgres + redis must be up; master admin must be bootstrapped first)
docker compose up -d postgres redis
cd server
.venv/Scripts/alembic upgrade head
.venv/Scripts/uvicorn app.main:app --port 8000 &
SVP_TEST_MASTER_EMAIL=master@you.com \
SVP_TEST_MASTER_PASSWORD=YourMasterPassword \
.venv/Scripts/pytest tests/test_v1_e2e.py -v

# Frontends
cd dashboard && npm run build && cd ..
cd master-dashboard && npm run build && cd ..
cd encryptor && npm run build && cd ..
cd mobile && npm run typecheck && cd ..
```

## Manual cross-platform tests (need hardware)

These can't run in CI without device farms; verify on real machines before
each release.

### Encryptor desktop app

- [ ] **Windows 11**: install `.msi`, sign in, register encryptor, drag a 100 MB MP4 in, encrypt, paste a Drive URL, log into student player → video plays.
- [ ] **macOS** (Apple Silicon + Intel): same flow.
- [ ] **Linux** (Ubuntu 24): same flow.
- [ ] Concurrency: drop 5 videos in queue, verify they finish without crashes.
- [ ] Forget master key → re-register works (with re-auth + paying a seat).
- [ ] Auto-updater: bump `ENCRYPTOR_LATEST_JSON` env var, relaunch, verify update prompt.

### Desktop player

- [ ] Same OSes. Login, scan a folder of `.svf` files, click play, verify decrypt.
- [ ] Disconnect from internet → cached license keys still work for offline grace period.
- [ ] After grace period expires → playback denied, prompt to reconnect.

### Mobile player — Android

- [ ] **Real device** (not emulator): build signed APK with `cargo ndk` for all 3 ABIs, install, sign in, navigate Library → Course → Video, play.
- [ ] FLAG_SECURE: try to take a screenshot → blocked. Try a screen recorder → blocked.
- [ ] Root check: install on a Magisk-rooted phone → playback refused with clear message.
- [ ] Offline: download a video, airplane mode, play → works within grace period.
- [ ] Watermark overlay visible, position changes every 30 s.

### Mobile player — iOS

- [ ] **Real device**: build signed IPA with the xcframework, install via TestFlight, sign in, play a video.
- [ ] Screen recording: start iOS recording → playback pauses (UIScreen.isCaptured).
- [ ] Jailbreak detection: don't have a jailbroken device for testing → covered by sysctl-based check on a normal device.
- [ ] AirPlay: try mirroring → playback continues but downscale + watermark stays visible.

## Format compatibility (the most important guarantee)

### Cross-language SVF roundtrip

The `svf-core` crate has 5 baked-in test vectors from `shared/test_vectors.json`
that prove **Rust derives the exact same key + decrypts the exact same
ciphertext as Python**. Run them after any change to crypto or SVF format:

```bash
cargo test -p svf-core --test integration -- --nocapture cross_language
```

If any of these fail, **stop the release**. The encryptor app and player will
have diverged from the Python tools/encrypt CLI.

### SvfWriter ↔ SvfFile roundtrip

The encryptor's `SvfWriter` writes a .svf; the player's `SvfFile` reads it.
The `pipeline_roundtrip_recovers_plaintext_and_hash` test in
`encryptor/src-tauri/src/pipeline.rs` validates this end-to-end with a
3 MiB input that crosses chunk boundaries multiple times.

### SVF format stability

Whenever you bump the `.svf` magic version (currently `0x0001`), update:
1. `crates/svf-core/src/svf.rs` — `SVF_VERSION`
2. `tools/encrypt/svf_format.py` — version constant
3. `shared/svf_spec.md` — bump the spec version
4. Cut new vectors in `shared/test_vectors.json` for the new format
5. **Force-update all encryptors** via the auto-updater before any new .svf
   files are produced — old players can't read new-version files.

## Release checklist (before publishing a new version)

- [ ] All automated tests pass
- [ ] Manual smoke test on each platform (Windows, Mac, Linux, Android, iOS)
- [ ] `BUILD.md` instructions still work for a fresh checkout
- [ ] Auto-updater manifest updated with new version + signatures
- [ ] Server deployed (`docker compose -f docker-compose.prod.yml up -d --build`)
- [ ] Database migrations applied (`alembic upgrade head` runs in container CMD)
- [ ] Master admin notified of any breaking schema/API changes
- [ ] Encryptor + player + mobile artifacts uploaded to your CDN
- [ ] `MEMORY.md` (this assistant's project memory) updated if the
      architecture shifted in any non-obvious way

## Known v1 limitations (deferred to v1.1)

- Master-scoped audit log viewer in master dashboard (placeholder for now)
- Login-as-student preview UI in tenant dashboard (server endpoint exists)
- CSV import + bulk-enroll UIs in tenant dashboard (server endpoints exist)
- Drag-reorder UI for course videos (server endpoint exists)
- Course intro video / resource attachment forms in tenant dashboard
- Watch-event aggregation rollup job (current path is on-write upserts;
  fine for v1 scale)
- Per-video paste-Drive-URL form on tenant dashboard's videos page
  (encryptor app handles it)
- iOS code signing + App Store review (need Apple Developer Program)
- Android Play Console internal track configuration
