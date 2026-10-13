# R371 integrated source handoff (replaces closed PR #23)

## Scope

Preserve all accepted R366 code and add the previously local R367 preset-ball
component plus the first three conversation repairs. No new ChatArchive recovery
or replacement gameplay implementation. PR #23 was unmerged and was closed;
this is not a revert of main or a production rollback. No server/APK publication.

### Changes

- Mod/get-more routes through the outer native retained-page host. Returning by
  Android Back retains the actual chat WebView, runtime document and conversation.
- Helper script preparation targets the chosen character BEFORE its change
  event; actual selected-store activation is awaited AFTER that change. Owner,
  launch and epoch are rechecked. Remove the fixed 500ms settle and stale-checkbox
  assumption; don't disable scripts to make loading look fast.
- Two embedded message iframe components are eager; standalone and script iframe
  behavior remain unchanged. Account/storage/worldbook/regex events are retained.
- Move known Google Fonts stylesheet links and unqualified imports AFTER the
  rendered card document load. Author scripts and ordinary styles are untouched;
  original font URL and link callbacks remain. A blocked font CSS request no longer
  delays the card's parser/scripts by 20 seconds. The system font is visible while
  the requested font downloads. No model/generation is started by this change.
- Same-origin rich/nested body long holds forward to the original message menu
  with exact message/document/scope fencing. Native text selection is not the
  default hold action; card controls/editable selection/scrolling remain usable.
- Keep the one-time legacy HTTP cache migration, then retain external cached
  card resources across future APK upgrades. Mutable first-party text keeps
  APK-local no-cache revalidation. Cookies, login and conversation DBs untouched.
- Add the preset component's missing metadata manifest (no duplicate bootstrap).
- Preserve binary attributes when exporting Helper's bundle: CRLF inside literal
  strings is not an incidental checkout line ending.

## Rebuild / deploy

1. Assemble `web-base.json` pin with `tools/bootstrap.py`.
2. Apply the 12 ordered `web-patches` through R366, R367, then R368. These are
   incremental patches, not full replacement trees and not duplicate cumulative
   overlays. The exact pin is `02069118baa83354f3e01a6d0021562111211373`.
3. Preserve `tools/preset-ball-build` and its lockfile; build from this complete
   repository, not an old native-only directory. Version 371 / 1.18.14.
4. Run Gradle unit/lint/build, `verify_apk_assets.py` and
   `verify_preset_ball_source.py`; review the clean reconstruction report.
5. R367 server metadata changes require separate baseline review and deployment
   of `server-patches/preset-ball-r367`. Existing deployed preset APIs remain
   supported, but a source PR does not deploy the new creator-bound metadata.

## Verification

- JS/CJS CI command: 2344 tests, 2343 passed, 1 environment skip, 0 failed.
- Python CI contract modules: 108 passed; R367 isolated contract: 5 passed.
- Gradle `testDebugUnitTest lintDebug assembleDebug`: 120 unit tests passed,
  0 failures/errors; lint/build passed (existing warnings are not a zero-warning
  or full-security-audit claim).
- Original four preset-component hashes, eight own mapped sources, generated
  input/output hashes match. Final default debug APK: 72.0 MB (isolated native QA
  build 72.5 MB), 1885 asset index entries, 621 frontend
  files, zero missing/stale files, source/compatibility-output hash parity passed.
- Clean reconstruction: 2288 files, 12 cumulative patches, zero differences.
- Ordinary Activity on isolated Pixel API35 emulator `.returnqa`, actual native
  input: five Mod/get-more/Back loops, same WebView/timeOrigin, no startup snapshot;
  rich-body menu and rollback cancel/commit passed. Actual supplied Daoyuan and
  synthetic card A/B/A retains the runtime. Real-click to observed complete frame:
  Daoyuan 1961ms first / 933ms warm; synthetic card 684 / 548ms. Before font
  deferral, Daoyuan samples 21000 / 21477ms included a measured 20036 / 20042ms
  Google font-CSS request. These are samples, not p95 or all-device guarantees.
- Final expanded native run also passed actual Daoyuan body hold → original
  rollback dialog → cancel, twice, with zero native text selection and unchanged
  opening. That run's click/frame samples were 1318/1048ms for Daoyuan and
  717/843ms for the synthetic card. The total test includes touch/scroll preparation
  and is not itself a conversation-speed measurement.
- Real iframe at 390x844 / 1440x900 with a deliberately held font CSS response:
  card scripts/button operate before font download; stylesheet/callback later
  apply without replacing the document. Original card controls and menu also
  exercised in the full-runtime browser fixture.
- Rich/nested gesture checks: 375x812, 390x844, 1440x900; controls, selection,
  scroll/cancel/stale scope pass with no unexpected request/page failures.
- Full runtime 1101-message archive: online, durable settings and offline
  new-document reopen, A/B/A, generation rejection and original rules verified at
  390x844 / 1440x900. This is functional/offline evidence, NOT instant loading.

## Limitations / provenance

- Wind's original singleton/React message path and separate cover HTML view were
  inspected. These changes adapt its retention contract to Homer's current
  runtime; they are NOT a literal transplant of a recovered compatible full
  SillyTavern loader. User accepted continuation after that distinction.
- First Daoyuan entry still took about two seconds in the native sample. Cold
  app startup and first-time external card modules/images are not guaranteed
  instant. The 1101-message offline browser still takes seconds. No hidden-error,
  disabled-extension or internal-ready-flag substitution is claimed as a fix.
- Font transformation deliberately falls back unchanged for custom CSP,
  ambiguous duplicate attributes, qualified/layered imports or other providers.
  It does not remove all network dependencies or bypass third-party access.
- Browser font/CDN requests can be aborted by real card variable initialization,
  subsequent conversation switches or context closure. No provider/account
  functionality is inferred merely from an absence of page exceptions.
- Native QA uses synthetic owner/provider/service and a supplied card, never
  real account archives or billable generation. Emulator is not OEM/device-wide
  coverage; browser visual checks have no original-phone pixel-diff baseline.
- Native automated touch had an intermittent missed Mod tap. Its scroll helper
  now uses instant scrolling and verifies rectangle stability before actual
  pointer injection; the final run passed. This does not establish that every
  possible production gesture issue is resolved.
- Backend patches are not deployed; no formal signed APK is published or merged.
