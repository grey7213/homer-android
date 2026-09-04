# Upstream provenance

- Project: SillyTavern
- Upstream repository: https://github.com/SillyTavern/SillyTavern
- Imported release: 1.18.0
- Release commit: `51ad27f`
- Source archive: https://codeload.github.com/SillyTavern/SillyTavern/zip/refs/tags/1.18.0
- Archive SHA256: `9FF16405D8DF12679049F238292CB313E6C59676BC268FB639E1DB1E8D74FDC2`
- Imported on: 2026-07-26
- License: AGPL-3.0

Homer-specific integration files and small upstream patches are documented in
`../specs/original-sillytavern-chat-migration-20260726.md`.

## Bundled compatibility extension

- Project: TavernHelper / 酒馆助手 (`JS-Slash-Runner`)
- Upstream repository: https://github.com/N0VI028/JS-Slash-Runner
- Bundled version: `4.8.19`
- Release commit: `0e965f2`
- Source archive:
  https://codeload.github.com/N0VI028/JS-Slash-Runner/zip/refs/tags/4.8.19
- Archive SHA256:
  `03C905748A1FDF469FE48246F499AEC4B6000866CE0FC4B3DAC16151E98D277F`
- Installed as a global SillyTavern extension:
  `public/scripts/extensions/third-party/js-slash-runner`
- JavaScript SHA256:
  `1A4631CCFF78AEFF87DFD5D54E5945E641DCA515914D9AA64C859225E225D67C`
- CSS SHA256:
  `05764D23141867A1DB59AFD33905D45F37650C30F7EED3F2C16DC2E36C5A32F4`
- `lib/jsoneditor.js` SHA256:
  `983629948B23A48A87150D4C0338D619DA5158BEDA31805C5DC68E24C6F64B8F`
- `lib/tailwindcss.min.js` SHA256:
  `3573A896869009F2AB0EA9870BA0279CB8BDA0DD45D710A83950367D19EE7EA9`
- Automatic updates are disabled. Installation, update, move, switch, and
  deletion endpoints are restricted to Homer administrators.

## Bundled prompt-template extension

- Project: Prompt Template / 提示词模板 (`ST-Prompt-Template`)
- Upstream repository: https://github.com/zonde306/ST-Prompt-Template
- Bundled manifest version: `1.17.6.8`
- Source snapshot: upstream `main`
- Source archive:
  https://codeload.github.com/zonde306/ST-Prompt-Template/zip/refs/heads/main
- Archive SHA256:
  `A53CE375A2CA6036035794B76C0CB1F55A090F307E60FFB409FEEC96D9211F7F`
- Imported on: 2026-07-28
- Installed as a global SillyTavern extension:
  `public/scripts/extensions/third-party/ST-Prompt-Template`
- The archive contains 241 files. Homer changes only the manifest
  `auto_update` policy from `true` to `false`; updates remain an explicit
  administrator action.

## Bundled memory-books extension

- Project: Memory Books (`SillyTavern-MemoryBooks`)
- Upstream repository:
  https://github.com/aikohanasaki/SillyTavern-MemoryBooks
- Bundled manifest version: `8.2.2`
- Source snapshot: the user-provided 2026-08-01 Homer backup; that archive did
  not retain an exact upstream commit identifier.
- Installed as a global SillyTavern extension:
  `public/scripts/extensions/third-party/SillyTavern-MemoryBooks`
- Automatic updates are disabled. Homer exposes the extension through the
  stable public alias `dialogue-memory-books` and keeps mutation actions
  administrator-only.

## Bundled Yuzi Phone extension

- Project: Yuzi Phone / 玉子手机 (`st-yuzi-phone`)
- Upstream repository: https://github.com/yuzi83/st-yuzi-phone
- Bundled manifest version: `1.4.2`
- Release commit: `00ddd047f81164e9a20abb6870dc54a72c328672`
- The user-provided 2026-08-01 backup did not contain this extension directory
  or any `st-yuzi-phone` / `yuzi-phone` text reference, although it was listed
  as an installed public extension. Homer therefore vendors the upstream
  release manifest, JavaScript/CSS bundles, and source maps from the pinned
  commit.
- Installed as a global SillyTavern extension:
  `public/scripts/extensions/third-party/st-yuzi-phone`
- Homer changes only `auto_update` from `true` to `false`; updates remain an
  explicit administrator action.
