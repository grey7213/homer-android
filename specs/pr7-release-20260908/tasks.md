# Tasks

- [x] Inspect exact PR head, successful original CI build, baseline and production updater feed.
- [x] Review embedded patch and reproduce group-chat removal, stale-account caches, unreadable dark confirmation, unrestricted preview and stale appearance editor.
- [x] Repair web regressions; 9 focused browser checks pass.
- [x] Initial 270 debug build, lint and packaged-asset audit pass (125 frontend files).
- [x] Finish real-runtime desktop/mobile checks and native Android Back verification.
- [x] Run final 271 unit/lint/release builds, asset and signing validation.
- [x] Update contributor PR, verify new CI head, merge and publish source/baseline.
- [x] Publish signed official APK to website and GitHub Release.
- [x] Verify official 270 -> 271 in-app upgrade, data preservation, public hashes and service health.

Generated evidence remains under ignored `output/pr7-release-20260908/`; no credentials or APKs enter Git.

## Verified candidate
- Debug/release JUnit: 32 + 32 passed; lintDebug and release/debug builds passed. Packaged frontend: 127 files, no missing files, 1133 index entries.
- Android API 33: 6 cache/patch instrumentation tests and 4 Back scenarios passed; confirmation and selection are cancelled, a form's cancellation guard is honored, the same-origin dialogue modal closes, and navigation is retained.
- Browser: 9 focused regressions and 8 page/native/viewport update-entry combinations passed. Real local backend/SillyTavern at 1440 and 390px generated a reply, persisted hide/collapse across reload, preserved the cloud message role, cancelled multi-selection and blocked switching during an in-flight presentation save. No unexpected console/page errors.
- Official release: 1.15.1 (271), existing package/certificate, 42,315,512 bytes, SHA-256 `f34a4807f2b1b37e8c97eace2a6079e5449d2cf17738ef90eff6e90d5c178154`; APK v2/v3 and alignment passed.
- Corrected PR head `5ccbd82` passed CI build 34215115916 and was merged as `3d54e8d`. Web source `b794ecc` is pushed; web-base `798eeac1209d` preserves `736853e86477` as its parent and contains identical web trees.
- Fresh updater E2E: all 10 scenarios passed. The installed audit package upgraded 270 -> 271 through Android's installer; firstInstallTime, HttpOnly Cookie, account identity, localStorage and cached conversation were preserved.

## Published and verified
- Website immutable APK: https://patcher.villainy.top/download/homer-android-1.15.1-271-release.apk ; canonical: https://patcher.villainy.top/download/ai-xingyue-latest.apk . Two independent full HTTPS downloads match the signed artifact; feed is JSON/no-cache.
- GitHub stable/latest: https://github.com/grey7213/homer-android-apk/releases/tag/release-1.15.1-271 . Uploaded digest and checksum attachment match.
- The actual official app automatically offered 1.15.1 to installed 1.15.0, downloaded it from production, requested per-app installation permission and upgraded through Android's system installer. No adb installation was used for this official upgrade. The installed base.apk hash equals the release; firstInstallTime remains `2026-09-01 08:36:29`, and manual recheck shows 1.15.1 / already latest.
- 61 production files independently re-hashed; backend/dialogue/Nginx active, public health OK; desktop/390px public login has no errors/overflow. Retired open-source URL remains 404. PR, merged main and refreshed-baseline main CI builds passed.
- Publication's first public verification hit a transient local-proxy TLS EOF after remote installation completed; independent direct HTTPS downloads and the real APK upgrade completed successfully afterward.
- Evidence: `E:/酒馆开发/output/pr7-release-20260908/`; local APK: `E:/酒馆开发/output/homer-release/homer-1.15.1-271-release-signed.apk`.
- Final evidence archive contains 58 hash-verified files. Task-owned audit apps/forwards and isolated services are cleaned up; the official 1.15.1 installation remains on the emulator.
