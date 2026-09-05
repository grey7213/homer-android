# PR 5 review and in-app APK updates

## Goal and scope
Review contributor PR #5 at `508740455ea04296a12a1e72f56041176363fe45`, validate native, web and notification-server changes, fix any material findings before publication, merge verified contribution, and publish the next signed APK.

Add an application update flow for users who installed the official APK: automatic nonblocking check on entry, a manual check in the app, release information, explicit download/install choice, progress/cancel/error/retry, and Android's installation confirmation.

## Acceptance
- Contributor regression tests pass against the actual integrated files. Notification writes retain admin authorization and text is rendered safely.
- Latest stable release is obtained over trusted HTTPS; higher Android versionCode is authoritative. No downgrades, wrong-package APKs, wrong certificates, corrupt files, arbitrary download URLs or partial downloads reach the installer.
- Android 8+ unknown-app-source permission has an explanatory screen and resumes installation after permission is granted. Decline/cancel leaves the app usable.
- Upgrading from published 1.14.4 (269) preserves the package, signing identity and application data; stale data-patch slots do not override newer bundled resources.
- Unit/instrumentation tests, APK asset audit, signing/alignment checks and actual emulator installation/update flow are recorded.
- Website release metadata/download hash and GitHub Release are verified after publication. Backend and web changes are deployed with backups and health checks.

## Non-goals
Silent installs, Play Store-only update APIs, new account/model/credit features, redesign, or clearing user data to make upgrade tests pass.
