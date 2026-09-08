# Design

Native main is `149e0e9`, PR 7's original head is `8e0a2b2`, and the web patch is pinned to `736853e86477`. Website release metadata currently identifies official 1.15.0 (270).

Reuse `ApkRelease`, `ApkUpdateManager`, `ApkUpdateController`, AndroidX FileProvider and Android's installer from PR 6. No additional update SDK is needed; the existing design/prior-art comparison is in `specs/in-app-update-20260905/`.

`HomerActivity.onBackPressed()` first asks the active same-origin document (and only its fixed dialogue iframe) to cancel the top web overlay. A handled cancellation stops navigation, including forms that prevent cancellation during a write. Otherwise the existing page/history navigation runs. Native installer/update dialogs keep Android's normal behavior.

The embedded web patch preserves group chat and personal tags, fixes stale-account private-card caches, uses readable confirmation colors, cancels appearance drafts on scope change, and restricts community previews to an authenticated administrator. An undeployed social moderation tab stays hidden.

Web implementation and detailed evidence live in `E:/酒馆开发/specs/homer-pr7-release-20260908-*.md`. Build from current verified web files; publish with the existing website publisher and the binary Releases repository. Use an immutable 1.15.1 (271) artifact with the established package and certificate.
