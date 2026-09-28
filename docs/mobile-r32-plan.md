# R32 失败生成免扣分与模型发送锁

## 范围与验收

- 包含本次修复与旧 #14 全部源码/补丁；新 PR 成功建立后撤回未合并 #14，不合并或部署生产。
- 上游 HTTP/JSON/SSE 错误、空白回复、流中断不扣本次积分；扣费后的最终写出失败须事务回滚；成功仅扣一次，保持积分类型与账目一致。
- 当前会话失败模型锁定发送（点击、回车及程序生成入口），小字提示更换模型；换不同模型才解锁，改温度/重开弹窗不解锁。不把余额/权限/登录错误当成模型拥挤。
- 手机 390×844 与桌面 1440×900 实测；单元/API 检查真实扣费余额和账目，构建与 APK 资源检查。模型故障用本机受控注入，不消耗真实上游。

## 计划

1. 已完成：检查上游解析、流终止、结算时机和前端生成链路。
2. 已完成：实现服务端校验/原子结算及前端会话模型锁，补失败回归。
3. 已完成：双视口包含重新打开会话的用例全部通过；保留本地存档完整性标识，不跳过完整性校验。后端 21 项、Node 44 项、Android 构建与资源核对已通过。
4. 已完成：导出单一累计 Web/后端补丁，干净基线验证；已创建 [PR #15](https://github.com/grey7213/homer-android/pull/15)，关闭未合并 #14 并留言只处理本次；没有合并或部署。
5. 提交后检查：远端 `build` 正在执行，最终结果以 PR #15 的检查为准；本地验证结果如下，不将待完成 CI 描述为通过。

## 边界与风险

不追溯调整过去的扣分。网络写成功只能说明服务器完成交付，无法保证手机实际收到；不以客户端报错接口任意返还积分。此改动不能宣称冷进入速度和 R31 编辑器重复保存问题已解决。账号/会话隔离及后台 quiet 生成必须保持正确。

## 维护者只处理本次

- Android：本 PR，版本 `1.17.2 / 280`。
- Web/Node：唯一 `web-patches/20260927-2056-cumulative-r25-r32.patch`，基于同一 pin `02069118baa83354f3e01a6d0021562111211373`，包括 #14 的所有 Web 和 R32 新改动。
- Python 业务服务：唯一 `server-patches/cumulative-r32/backend.patch`。继承所有旧改动，六模块累计补丁；不用旧包再打本轮增量。
- 先 `git apply --check`，有基线冲突则审查合并，不强制覆盖。同步两个服务、正式签名和热更新槽，不能只换 APK。此次提交没有合并或部署正式服。

## 验证命令

- `HOMER_BACKEND_SOURCE=<累计后端主文件> HOMER_R26_STAGE=<累计后端目录> python -m unittest tools.tests.test_mobile_r26_host tools.tests.test_mobile_r29_backend tools.tests.test_mobile_r32_billing`：21/21。
- `node --test tools/tests/mobile-r28-session.test.mjs tools/tests/mobile-r29-generation.test.mjs tools/tests/mobile-r30-admin.test.mjs tools/tests/mobile-r31-autocomplete.test.mjs tools/tests/mobile-r31-shared-host.test.mjs tools/tests/mobile-r32-model-gate.test.mjs tools/tests/mobile-r32-chat-header.test.mjs`：44/44。
- `gradlew.bat -p android-app testDebugUnitTest lintDebug assembleDebug`：通过，43 项 Android 单测零失败。
- `python tools/verify_apk_assets.py`：1,387 资源清单项、182 frontend 文件，无缺失，原始和兼容编译资源双哈希一致。
- `python tools/verify_cumulative_web.py --patch web-patches/20260927-2056-cumulative-r25-r32.patch --destination <新验证目录>`：从 pin 干净装配，1,788 文件与当前源码一致，无遗漏。
- `python tools/verify_cumulative_server.py --baseline <原始六模块基线目录> --package server-patches/cumulative-r32 --destination <新验证目录>`：`git apply --check` 与应用通过，6 模块结果哈希全部一致。
- `tools/tests/mobile_r32_e2e.py`：真实 APK 资源、本机业务/Node 服务、受控合成上游；390×844 与 1440×900，失败不扣分、发送/回车不重发、重新打开仍锁定、实际模型弹窗换模型后成功，成功扣配置的 7 分一次。两种尺寸脚本错误与 HTTP 错误均为 0；不等于正式模型/华为实机验证。
