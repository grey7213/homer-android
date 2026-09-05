# Homer Android working notes

- Native source of truth: this repository's `android-app/`. Web source of truth: `E:\酒馆开发` (`grey7213/AIXingYue`). Never overwrite either tree with a contributor's full copy; apply and inspect patches against their pinned baseline.
- Read `MAINTAINER.md`, `CONTRIBUTING.md`, and the relevant `specs/` before changing release behavior.
- Windows builds require an ASCII path, JDK 17+, SDK 35+, Node 20+. Use Android Studio JBR and `E:\Android\Sdk`.
- Assemble the pinned web tree with `python tools/bootstrap.py`; apply pending patches with `python tools/apply_web_patches.py --strict`. For production build inputs, use verified main-workspace web files.
- Verify with Gradle `testDebugUnitTest lintDebug assembleDebug`, device tests when available, and `python tools/verify_apk_assets.py`. UI changes require rendered/device checks.
- Preserve package `org.nebula.horizon.composeai` and the established release certificate. APKs, credentials, keystores and temporary evidence never enter Git. Evidence belongs under ignored `output/`.
- Main is protected; review PR code and its `build` result before merging. Push verified source commits and release APKs through `grey7213/homer-android-apk` Releases plus the existing website publisher.
- Java bridge calls must retain the injected receiver: `window.HomerNative.method(...)`.
- `PatchManager` data patches override bundled web assets; an APK release must account for old slots as well as update the published data patch when needed.
- Current task map: `specs/in-app-update-20260905/`.

## Verified pitfalls

- Symptom: An APK upgrade can still load an older activated data patch. Cause: Patch slots outrank bundled assets. Fix: Clear only activation metadata when the bundled APK version changes; require a patch's `min_app_version` to match that version. Verify: `PatchUpgradeTest` on API 33 preserves a separate account sentinel and keeps a current-version slot on ordinary restart.
- Symptom: Shell `uiautomator dump` appears to show a stale update dialog during downloads. Cause: Frequent progress accessibility events prevent its idle wait from completing, leaving the previous XML on disk. Fix: Remove the previous task-owned dump before capture; exercise progress cancellation with Android Back after observing an actual download and screenshot. Verify: Ten emulator update scenarios passed, including cancellation and removal of the partial file.
