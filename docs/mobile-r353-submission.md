# R353 验收成果提交

## 内容

本提交以当前 `main`（`0f41f3b`）为基础，包含此前已验收的累计会话改动及本次文字呈现优化，不是只提交最后几处 CSS。

- 复用会话运行时、预备历史会话、减少大卡重复传输和重复渲染；保留账号、文档与会话身份校验。
- 修复作者 HTML 前端、开场切换、官方显示正则边界和扩展就绪权限；保留脚本及世界书功能。
- 自绘界面使用透明的软件宿主，保留作者自己的边框、背景和 iframe 身份；混合消息的普通段落继续使用普通气泡。
- 支持对白、括号与旁白的颜色/字体层级；已有界面设置增加文字页签、预览、保存、取消、默认值和账号/会话隔离。
- 保留本次验收前已有的模型分组、管理会话工作区、工坊文件导入、正则预览及标签反馈功能。
- 首页进入社区；保留外层页面并减少重复布局。保留主分支 #18 的工坊账号缓存隔离修复。

正式包名、签名和更新链路沿用当前主分支。版本递增至 **353 / 1.18.0**；本地构建是 debug 签名，不能作为正式签名发布包。

## 补丁落地

`web-base.json` 的基线仍为 `02069118baa83354f3e01a6d0021562111211373`。

`web-patches/20261006-r353-01-of-05.patch` 至 `05-of-05.patch` 是**同一个累计交付的五个分段**，每个文件只出现在一个分段中。按名称顺序全部应用。分段仅用于控制单个 Git 文件大小，不能遗漏其中任意一段。

旧 R25–R33 累计补丁和工坊增量补丁已被合并到该集合，不要再叠加旧补丁。

```sh
python tools/bootstrap.py
python tools/apply_web_patches.py --strict
cd android-app
./gradlew testDebugUnitTest lintDebug assembleDebug
cd ..
python tools/verify_apk_assets.py
```

扩展 TS 与源码映射统一 LF；经核验的局部 JS 补丁通过 `.gitattributes` 保留其非目标字节。导出工具保留 diff 中的 CRLF，不再经通用换行解码破坏内容，且分批纳入新增文件以避免 Windows 命令行长度限制。

## 已执行验证

- 在全新基线上应用五段补丁：2,155 个源码文件 Git blob 校验一致，无遗漏。
- `node --experimental-vm-modules --test --test-concurrency=1 tools/tests/*.test.mjs tools/tests/*.test.cjs`：1,698 通过、0 失败、1 个非必需桌面基准测试跳过。
- Gradle `testDebugUnitTest lintDebug assembleDebug`：构建通过；94 个 Android 单元测试通过，0 失败、0 错误。
- Python 导出、服务端转换与缓存契约：48 个测试通过。
- `verify_apk_assets.py`：1,752 个清单条目，518 个前端文件，缺失 0；原资源、兼容编译输入和产物哈希校验通过。
- `mobile_r45_presentation.py --apk ...`：390×844 和 1440×900 的实际 APK 资源测试通过，脚本错误 0、请求失败 0；检查 iframe 身份、作者样式、混合正文、流式文字和设置保存/取消/隔离，截图已查看。

本次隔离构建 debug APK SHA-256：`3BBE6667AA5FCFD438A11670950809EE8EDB807794905ABDC47EEFF6713A740A`。APK、凭据、签名材料和本机证据不进入仓库。

## 服务端交接与边界

`server-patches/cumulative-r41` 是完整累计服务端交接包，保留 R33 的生成、计费和图片功能，并增加会话卡转换缓存。它替代 R33 服务端包，不能与旧累计包重复叠加；部署前必须检查每个模块的基线/结果哈希。Android PR 合并不代表 Python 或 Node 服务已经部署。

本轮未重新测量实体手机冷启动/跨卡性能，也未进行正式账号的真实模型生成和计费测试；合成资源测试不冒充这些检查。此前手机验收与本轮干净构建回归是不同证据。
