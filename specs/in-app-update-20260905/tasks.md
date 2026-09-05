# Tasks

- [x] Read repo workflow and verify current PR head, CI build success, official 1.14.4 (269), original package/certificate metadata.
- [x] Compare open-source updater projects and document implementation choice.
- [x] Review all PR code and web/server patches; no blocking defect found. PR #5 merged as `30c9918d63ce67023f5e940281c5eb87fdb6114f`.
- [x] Integrate patches without reverting newer main-workspace changes.
- [x] Implement in-app update transport, integrity/signature checks, native UI and manual entry.
- [x] Handle old data-patch slots on APK upgrade. Current/public predecessor builds have an empty patch key and no live signed data-patch channel; no extra channel was created.
- [x] Pass unit/lint/build/assets, backend/browser regressions and emulator install/update scenarios.
- [ ] Merge reviewed PR, commit/push integrated source and refreshed web baseline.
- [ ] Back up production, deploy relevant notification/web resources, publish signed APK and GitHub Release.
- [ ] Verify public downloads, metadata, source hashes, services and post-upgrade behavior; record evidence.

## Local evidence (2026-09-05)
- 32 JUnit tests passed; lintDebug and release/debug builds passed; 111 frontend files present, asset index 1117 entries, compiled runtime lib 1902 KB.
- API 33 emulator: 5 contributor SQLite tests plus 1 real PatchManager upgrade test passed.
- Isolated updater E2E: current version, unavailable feed, external origin, bad hash, truncated file, wrong package, wrong signer, cancel, permission decline/resume and system-install upgrade all passed. 269 → 270 preserved firstInstallTime, an HttpOnly cookie, account identity, localStorage and cached conversation.
- Official release signed with existing certificate `429b4165d958750c1fa90289c23b6d9b6d45ff915b535c5b1fbc72d52d93f320`; v2/v3 and zipalign passed. Final artifact is rebuilt if bundled version copy changes.
- Evidence: `E:\酒馆开发\output\apk-update-20260905\`, including `device-update-results.json`, screenshots, build log and signing verification.
