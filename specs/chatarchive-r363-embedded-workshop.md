# R363 — restore embedded workshop, verified source handoff

User superseded R362 native directory on 2026-10-09: use the previous direct
embedded website. R362 APK is retained as an immutable superseded artifact,
not recommended for the new request. This phase originally prohibited submission.
The subsequent explicit request, "直接提交吧", authorizes source commit/push and
updating existing PR #22 only. It does not authorize merging, an official APK
release, website publication or server deployment.

## Plan / acceptance / risks

- [x] Inspect original R361 embedded host and R362 fixes.
- [x] Replace native catalog with full same-origin site WebView.
- [x] Preserve insets, visible error/retry, origin separation and verified download.
- [x] Verify actual public site/forms, safe-area rotation, offline fallback,
  origin restrictions, retained game document and private local media rendering.
- [x] Build from approved clean R361 Web baseline, verify assets/signature and
  deliver a new immutable R363 local APK.

Full site pages and login UI come from the actual site, not copied implementation
or a native re-creation. No Homer bridge/account/save is exposed. Same-origin
cookies persist through normal WebView storage only. Anonymous downloads still
require the site's normal authorization; user canceled the SSO/native-catalog
approach. No access/verification bypass or shared account is authorized.

Protect downloaded immutable resource/revision/SHA binding and explicit download
confirmation. On error/cancel preserve installed media and all saves. Do not
silently update missing-version saves to a newer package. Main-frame load alone
is not content readiness; require visible rendered controls before clearing the
fallback, bounded timeout otherwise. Restore orientation without recreating game.

Risks: external site/network can fail; old WebView may not support its JS;
authenticated login-to-download and real phone still require user acceptance.
Separate R361 cloud server deployment remains outstanding; no uninstall test.

## Observed embedding contract

- Initial page is the actual /characters/ website, or a saved resource's
  /mods/{id}/ detail. Search, categories, detail, login and site menus are the
  site's own document, not the superseded native catalog or a copied frontend.
- Android chrome has a compact back/title/refresh bar below system/cutout
  insets; navigation/IME safe areas shrink the actual WebView. Rotation retains
  the same Activity, WebView and document, with no game or account bridge.
- Exact same-origin HTTPS main-frame navigation only. Site subframes and
  verification resources use ordinary WebView networking. Invalid TLS fails
  closed. An element/geometry readiness probe reads no form values, and waits
  for visual state before removing the host feedback. Error/timeout has retry.
- Site login uses its own normal form and verification. Cookies persist via
  WebView's normal storage; there is no SSO or shared/packaged account.
- /download/{revision}/ is intercepted before navigation. Public metadata must
  bind current resource/revision/SHA/size. Explicit confirmation alone starts
  own-origin authenticated download; anonymous 401 writes no package bytes.
  Metadata/dialog callbacks are fenced against navigation/destruction.
- CAPK/ZIP is validated and installed atomically. TXT/JSON presets use the
  system file-save picker and never apply automatically. Unsupported formats
  are reported. Cancel/hash/size errors preserve existing media and saves.
- Saved media recovery pins the original revision/SHA. No automatic replacement
  by a newer revision, generation, billing or new conversation on restore.

## Verification record

Clean build base: native HEAD c8255bbe + eight scoped native deltas; approved
output/chatarchive-r361/clean-web-final, not the unrelated dirty Web worktree.
1843 assets/client entries match the preceding accepted baseline byte-for-byte.
No preloaded/private CAPK/HCAP/ZIP or test fixture in the main APK.

Unit checks: 115 cases, 114 pass / 1 optional sample skip / 0 failures. Gradle
testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest succeeded;
lint 0 errors / 10 warnings. verify_apk_assets.py: 1849 manifest entries,
613 frontend files, none missing, source/output double-hash validation passed.

Browser regression: 6/6 (390x844, 844x390, 1440x900, light/dark), no script/HTTP/
network failures; actual local workshop Spine media with 39 animations, but
identity/provider/native bridge synthetic. Save/branch restore in a private
HTTP/SQLite test provider, not production cloud deployment.

Real Android API35 checks use ordinary site public pages and anonymous protected
download rejection; synthetic HTTP-error callbacks are distinctly labelled.
Rotation/retained ordinary document and private media/game rendering also tested.
Final stable-frame/pixel-gated run: 9/9 pass in 43.135s, API35 emulator. Authenticated login/verification/download on a
real phone remains untested; do not equate password-form presence with login.

Earlier failed runs are preserved under output/chatarchive-r363*.log. A test
initially sampled the preceding document before navigation; DOM/path waiting
replaced arbitrary timing. HTTP-error interception and a live unknown/404 route
were not deterministic offline fixtures, so the negative test now sends an
explicit synthetic main-frame HTTP-error callback. Initial screenshots sampled
the native feedback transition despite DOM/visibility readiness; three native
frames plus a settling interval now precede capture. First catalog also required
an actual site-color pixel gate to reject the platform's stale launch snapshot.
The previous-paint catalog screenshot is retained. Real catalog/detail/login captures
were inspected and show the site, empty login fields and unobscured host bar.

Live tests used the PC's pre-existing HTTP proxy via emulator-only
10.0.2.2:7897; direct TLS on this PC/emulator previously timed out. This is not
shipped in the APK; each final test resets the emulator proxy to its prior null.
No user credentials, CAPTCHA bypass, desktop session transfer, external write,
commit/push/PR update, official release or server deployment.

Skills used: create-plan (read-only planning), authorized-reverse-analysis
(public interface/behavior scope), android-clean-architecture (transport vs
host separation), webapp-testing (native Python Playwright regression).

## Local handoff

R363: D:/网站/验收包/ChatArchive-R363/惑梦-嵌入角色工坊-R363-debug.apk
74,637,731 bytes; org.nebula.horizon.composeai.uireview / 363 / 1.18.10-debug.
SHA256 314D3067C093529305208E350467BD93A772B0823349A64978D1504CE33DEC65.
Same debug certificate as the preceding acceptance APK; adb install -r retained
app data. Upgrade the previous acceptance package, do not uninstall/clear data.
Production HTTPS interface unchanged. No proxy configuration in the APK.

Evidence: output/chatarchive-r363-final-build.log,
chatarchive-r363-pixel-build.log / pixel-native.log (9/9),
chatarchive-r363-final-assets.log, chatarchive-r363-browser.log,
output/chatarchive-r363/native-evidence/ (stable actual site and safe areas).
Both earlier incomplete/failed runs and immutable R361/R362 APKs are retained.
At local APK handoff HEAD remained c8255bbe; no new commit/push/PR/server or
official APK update had occurred. The source submission below is subsequent
authorization, not a claim that production deployment has happened.

## Source submission scope

- Eight native build/host/client/test files match the clean R363 build inputs
  by SHA-256. The approved R361 Web patch chain is unchanged; unrelated dirty
  Web files and stopped integration files are excluded.
- Submit through existing `feat/chatarchive-workshop-r361` to PR #22 targeting
  `grey7213/homer-android:main`, without rewriting published history.
- Preserve the cumulative R361 delivery and ordered server rollout instructions
  in the PR. Review the new head's build check; the previous green head is not
  evidence for the new commit.
- APKs, private samples, screenshots, credentials, signatures and build output
  remain outside Git. The accepted immutable APK is not replaced by this step.
- GitHub PR history/checks are the authoritative submission and CI record.
  Workshop login and the separate cloud deployment limitations above remain.

Submission workflow skills: create-plan, ECC git-workflow and github-ops.
