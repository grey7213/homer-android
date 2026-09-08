# Reviewed PR 7 and 1.15.1

Review the contributor's complete embedded web patch, fix confirmed regressions, merge the verified PR and publish the official APK. Preserve existing group chats, account isolation and the in-app updater introduced in 1.15.0. Android Back must close web dialogs before navigating.

Acceptance: Android unit tests, lint, build and packaged assets; desktop/mobile browser checks; real emulator dialog cancellation and 270 -> 271 installation through the updater; matching official signing identity and verified website/GitHub downloads. User data must remain intact.

No silent installation, new updater framework, new community backend, production fixture writes, or signing material in Git.
