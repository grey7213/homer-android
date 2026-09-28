# R25–R31 累计提交（替代旧 PR #13）

## 计划与验收

1. 已完成：确认旧 PR #13 未合并，新分支保留其全部提交；不撤销已合并代码。
2. 已完成：导出唯一累计 Web 补丁和唯一累计业务后端补丁，核对与本机源码一致。
3. 已完成检查：干净基线还原、单测/构建/资源校验通过；完整生成回归未全通过，见限制，不作为生产验收通过。
4. 进行中：推送新 PR，关闭 #13 并双向标明替代关系，核对 CI。

验收：包含 R25–R27 全部旧改动及 R28–R31 新改动；Web pin 可重新装配；不叠加旧增量；无凭据或用户数据；真实报告测试结果。

风险：后台接口不是安装 APK 就能部署；正式签名、热更新槽和服务端必须配套。不同生产基线必须审查合并，不强制覆盖。没有授权合并或部署生产。

## 已知限制（不是已解决）

- 前次冷启动浏览器实测约 2.74–2.78 秒；提交前再次运行完整服务时为 7.28/7.41 秒，仍未达到稳定秒开，波动原因未定位。
- 共享运行时暖切换前次约 0.82–0.94 秒，本次 2.32/1.98 秒。不得只引用最好样本或以隐藏遮罩宣称修复。
- 扩展编辑器第二次保存的自动化回归未通过；不能据此声称所有扩展已验收。
- 累计后端完整生成 E2E：移动视口一轮完成；桌面首轮两次遇到 `HM-G502`，另一次卡在输入框不可见。没有定位完成，不能沿用旧 R29 报告宣称当前整合版全通过。需要进一步排查测试数据隔离、连接就绪及生成链路。此项与性能/编辑器一起作为正式发布前未通过门槛。
- 无连接中的华为实机验证；本机浏览器回归不能冒充正式服务器、真实模型或所有机型的验证。

用户已明确要求交付此阶段 APK 并累计提交。此提交不等于上述限制消失。

## 技术人员只处理本次

旧 #13 的两个提交完整包含在本分支，叠加 R28–R31；无需再合并 #13。

1. Android 原生壳按本 PR 审查合并。
2. Web/Node 唯一补丁：`web-patches/20260927-1310-cumulative-r25-r31.patch`。相对 `web-base.json` 的 `02069118baa83354f3e01a6d0021562111211373` 导出。包含全部本地前端、运行时、扩展按需加载 chunk，而非只改壳层。不要叠加旧 R27/R28/R29/R30 补丁；旧文件已移出自动应用目录，本地留档及 Git 历史可恢复。
3. Python 业务后端唯一补丁：`server-patches/cumulative-r31/backend.patch`，详见该目录 README 和基线/结果哈希。此处额外解决了旧 R25–R27 与后续 R29 不同基线的合并，不能只应用后续 R29 增量。
4. 生产已有改动时先检查、审查合并冲突，不重置或整目录覆盖。更新两个服务、正式签名 APK 和版本匹配的热更新槽；不要把仅合并此 Android PR 视为全部更新完成。

## 已完成的提交前验证

- `tools/verify_cumulative_web.py`：新建隔离 clone，检出 pin，`git apply -3 --index`；1,787 个文件逐个 Git blob 哈希与当前源码一致，差异为零。
- `tools/export_r31_server.py`：六模块累计后端补丁；核对 R29 输入基线、编译 Python、四个旧模块正向 round-trip。
- `HOMER_R26_STAGE=.../server python -m unittest tools.tests.test_mobile_r26_host`：9/9。
- `HOMER_BACKEND_SOURCE=.../server/ai_fengyue_local_server.py python -m unittest tools.tests.test_mobile_r29_backend`：7/7（测试累计结果，不是只测旧主文件）。
- `node --test tools/tests/mobile-r28-session.test.mjs tools/tests/mobile-r29-generation.test.mjs tools/tests/mobile-r30-admin.test.mjs tools/tests/mobile-r31-autocomplete.test.mjs tools/tests/mobile-r31-shared-host.test.mjs`：37/37。
- `gradlew.bat -p android-app testDebugUnitTest lintDebug assembleDebug`：通过。
- `python tools/verify_apk_assets.py`：1,386 清单项、182 frontend 文件，缺失零；源码/兼容编译双哈希一致。
- `mobile_r31_shared_host.py`：390×844 与 1440×900，同一 iframe、普通草稿恢复、管理员预览不写历史、拒绝后同宿主重试、无自动生成；脚本错误零，只有故意注入的 403。性能未通过，数据见上。

阶段 APK：`1.17.1-debug (279)`，`app.huomeng.homer.debug`，连接既有正式服务但不会部署新后台。SHA-256：`C4394B0E7CD6FD88EDFA5DD7BCF70A6955E363391D15C97E62C74C64B0A2B8C6`。这是调试签名，不是官网正式签名版本。证据和私有测试数据只留本机忽略目录，不提交。
