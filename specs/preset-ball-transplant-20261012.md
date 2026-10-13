# Authorized Dream preset floating-ball source transplant

User confirmed possessing reuse permission and explicitly requested direct source transplantation on 2026-10-12. This is a local-only task: no commit, push, release or server deployment is authorized. The confirmation is recorded as user-supplied authority, not a substituted open-source license.

The source is the original `sanmingyue-preset-tool.js` loader in Dream 3.0.13 and the loader's current CDN module (SHA-256 `fc14319990d4aeff66942f434129f9457e8febc4ed04390a20709432fdbe6b54`). Literal sourcesContent contains the Vue components. The module is identified in its CreditsView as by shiyue67. Its current remote bytes are not claimed to be a historical phone capture.

Implementation plan:

1. Compile the recovered App, PresetView, PromptItem and BatchToolbar sources locally. Preserve upstream copies and record every adapter difference. Active.
2. Replace only host/data dependencies: scoped public entry metadata, durable per-conversation toggles, safe ACK/status, and correct retained-runtime lifecycle. Exclude upstream prompt editing and remote repositories from this ordinary-user module.
3. Bind existing settings entry, Back/cancel, new/switch/reopen, and generation fence. Do not reload chat or initialize another runtime.
4. Verify real rendered mobile/desktop interaction, unit/API contracts, offline persistence, stale account/conversation responses and ordinary-chat regressions. Generation without successful pending-setting ACK must be blocked, never billed using silent stale settings.
5. Export reconstructible source/bundle/map changes, run Gradle unit tests/lint/debug build and APK graph checks. Do not claim untested Android device behavior or production backend changes.

Acceptance: original-code-derived ball can drag/tap, original panel can search/select/switch entries and expand; no private prompt contents or unrestricted controls reach the UI; same-conversation overrides survive reopen while other/new conversations retain defaults; late writes cannot affect a new scope; UI stays local and responsive; actual generation uses acknowledged settings; package includes all pinned dependencies with no CDN bootstrap.

Relevant gaps: current runtime API favors model-global preset and lacks explicit card/global catalog fields. Existing server source supports both card/global overrides and generation composition; integration must preserve this and provide a separately deployable metadata contract patch if needed. Main production web source path is unavailable here, so incremental patch delivery must not be ignored-cache-only.
