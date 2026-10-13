# R366 整合交接（2026-10-11）

## 执行提示

撤回未合并的上次 PR #22，在最新 main 基础上保留先前已接受的功能，并完整整合本轮 Android 原生修复、内置前端资源、增量服务端补丁和可复跑测试。原有脏工作区不重置；不变更账号数据，不部署正式服务，不合并或发布。不能将合成环境测试等同于真实账号、真实模型、跨设备或百次全功能验收。

## 计划与验收门禁

1. 已完成：核对上次提交和远程 main；#22 未合并，已关闭并保留原分支。
2. 已完成：从 d19b573 独立装配 fix/integrated-r366。它已包含 main 3eeeeb7；保留原九份补丁，增加第十份 20261011-integrated-r366.patch。源码与本地选定范围逐文件字节比对无差异。后端契约测试改用随仓库提供的纯代码隔离样本，不依赖私人目录。
3. 已完成：固定 web 基线重放十份补丁，2266 文件内容一致，Git 树均为 9864664b2d6d148c36c45a5ce15b5ee02efa9930。Windows checkout 的 1156 项差异仅为 CRLF/LF，没有内容缺失；bundle map 路径改为跨平台分隔符。Node/Python/Java、lint、APK 资源及移动/桌面闭环验证结果见下。
4. 进行中：提交范围与敏感数据已检查；提交并推送整合分支，建立替代 PR，核对远端 SHA 和 CI。不自动合并。

## 整合范围

- 本机优先会话快照、账号/会话隔离、删除墓碑与批量删除、真实空删除与迟到空快照保护。
- 当前会话的记忆范围、预览、保存、编辑、开关和注入；云备份校验/ACK 契约。
- 管理员会话草稿隔离；收益只计积分的结算契约；续写语义；私人资源删除和文件导出。
- 发帖草稿与权限检查、媒体迟到结果保护、调色控件、原生拍照和导航停止保护。
- Android 原生、APK 内置前端及回归测试同步交付；只更改前端源码依赖，不部署网页。

## 服务端交接

新目录为 server-patches/creator-revenue-r366、server-patches/resource-flow-20261011、server-patches/memory-cloud-r366。按照各目录 README 与 manifest 对维护中的源码核对基线后逐项应用；不能将所有历史补丁盲目重放到已修改的生产服务器。

仓库内 tools/tests/fixtures/r366 只用于隔离契约验证，不是完整服务器或部署替代物。用户没有测试服务器，因此新服务端补丁未部署，正式同步/结算/资源删除未判定通过；邀请奖励真实结算合同仍缺失，不构造虚假金额。

## 已知未达标/未测范围

前序同源隔离 HomerActivity 测量：首次历史约 3.6 秒、暖切约 1.4–1.8 秒、记忆约 1.5–1.7 秒，仍不能称秒开。原账号、真实大卡与模型、完整百次游玩、所有 OEM 相机和跨设备升级未完全验证。本 PR 是整合交付，不是全部性能/生产验收通过的声明。

版本号统一为 366 / 1.18.13；常规 debug 仍使用独立 .debug 包名和现有服务器地址，不更改正式版安装数据。

## 本轮可复核证据

- `node --experimental-vm-modules --test --test-concurrency=1 tools/tests/*.test.mjs tools/tests/*.test.cjs`：2299 项，2298 通过、0 失败、1 项既有基准跳过；内存模块单独再次验证 12/12。
- CI 所列 Python 服务端/导出合同测试：合计 108 通过。使用 Python 3.13；代码隔离样本的字节摘要同步验证。原先组合导入不兼容和私人路径依赖已修正。
- `gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest`：成功。Java 118 项，117 通过、1 项需要外部授权真实素材包的既有测试跳过；lint 0 错误、10 警告。
- `python tools/verify_apk_assets.py`：1863 清单资源、621 前端文件无缺失，原始资源与兼容编译的输入/输出摘要一致。
- 最终 APK 编译资源浏览器流程：发帖 4 场、调色 4 场、呈现 2 场（390×844、1440×900，明暗主题），无脚本错误或意外请求失败；权限失败/发布失败是主动注入并验证恢复的情况。
- 管理员独立编辑器 38 个操作场景通过，无全局配置写入；资源取消/删除/搜索/实际可导入导出、农场与评论失败重试分别在两种尺寸通过。全部使用本机合成服务和身份，不冒充真实模型/正式授权测试。
- Android 模拟器实际打包资源与原生桥：HistoryDeletionUiTest、HomerCacheDatabaseTest、MemoryBindingsUiTest、ResourceExportDeviceTest、WebCameraCaptureDeviceTest 合计 14/14 通过，完整流程 241.058 秒，**不是入口性能测量**。
- 首次设备复验 13/14：测试私有镜像导入不能供独立服务的角色列表使用；已改成仅回环服务的真实导入并重新验证。独立 npm ci 安装锁定依赖，不通过依赖 junction 绕过服务器文件边界；原失败日志保留。产品权限/网络 allowlist 未为测试放宽。
- 本地 debug APK SHA-256：627A58F59DF90344ADD26BF10D6C29590B9E9F05979BEBA769CA221D5F48C78C。完整日志/合成截图在本工作区忽略目录 output/submission-r366，不进入 Git。
- 源文件空白检查通过，补丁空上下文的单个空格按 Git 格式保留。候选凭据检查的四处匹配均为合成脱敏测试值；无实际凭据/原用户数据/签名材料或 APK 提交。

复跑浏览器需安装 Python Playwright 和 Chrome；管理员 Node 浏览器脚本使用工作区的 Playwright 或显式 HOMER_PLAYWRIGHT_MODULE，不硬编码桌面软件安装位置。设备记忆测试先启动 tools/tests/memory_private_runtime_server.py 并只反向映射回环 8802；不得把正式数据或账号挂在该测试服务。
