# Design

## Current map and baseline
- Java Activity + WebViews; minimum SDK 26, target/compile 35. Public 2026-09-05 release: 1.14.4 (269).
- `HomerActivity` owns lifecycle, native bridges and local web resources. `PatchManager` manages signed data-only A/B slots.
- Website `/download/release.json` has a canonical artifact and a files array containing package/versionCode/size/SHA-256/certificate. Reuse this feed and existing immutable versioned download URLs.
- Production publication and service tooling live in `E:\酒馆开发\tools`. Github binary distribution is `grey7213/homer-android-apk`.

## Prior art (queried live on 2026-09-05)
- https://github.com/xuexiangjys/XUpdate — Apache-2.0, not archived, last push 2024-03-24. Mature generic checking/downloading/install flow; broad integrations and customization exceed this native shell's needs.
- https://github.com/jenly1314/AppUpdater — MIT, not archived, last push 2026-08-04. Evaluate its small Android download/install implementation and official platform APIs; preserve attribution if source is copied.
- Android PackageInstaller / FileProvider and `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES` are the platform install and permission mechanism. Play in-app updates require Play distribution, so they do not fit website APK distribution.
- Chosen implementation: reuse Android's installer and AndroidX FileProvider with the existing website release feed. Keep transport/validation isolated from lifecycle/UI, with no additional update SDK or external telemetry. Validate source, package, version and certificate before installation.

## Modules and flow
- `ApkRelease`: strict feed parser and latest-compatible-release decision; immutable `/download/*.apk` URLs.
- `ApkUpdateManager`: bounded HTTP downloads, SHA-256/size verification, package/version/certificate inspection; cancellation and private cache files.
- `ApkUpdateController`: Activity UI and lifecycle, single-flight auto/manual check, explicit download, progress, unknown-source settings and system installer handoff.
- Trusted native bridge exposes only fixed update actions/version information, never arbitrary URLs or install commands.
- Profile and login expose a small update action using the native bridge. Existing web-only behavior stays functional.
- New APK invalidates only older data-patch activation metadata (not login, messages or other user data). Published data patches carry a minimum compatible app version.
- From 1.15.0, a data patch's legacy `min_app_version` field must equal the receiving APK versionCode, preventing an older patch from overriding a newer APK. The existing release and current build have no patch public key, so distribution remains through signed APKs.
- Website metadata is noncached. Publication rejects a different APK under an existing versionCode or immutable URL and switches the canonical APK with an atomic rename. Identical retries remain supported.
- Web baseline publication preserves the previous snapshot as a parent and uses a normal fast-forward push. Bootstrap installs the pinned runtime lockfile with `npm ci`.

## Implementation order
1. Review and integrate PR in local workspaces; reproduce material issues and fix them.
2. Implement update model/transport/UI/bridge and publishing metadata support.
3. Run offline regression, build, emulator scenarios, then merge source and publish backend/web/data patch/APK in compatible order.
4. Verify public artifacts and record exact commits, checks and remaining limitations.
