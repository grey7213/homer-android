# R360 Android 游戏横屏修正

当前范围仅本地 Android 工程。大厅、舞台、MomoTalk 自动沉浸式横屏；离开恢复此前请求方向与系统栏状态。普通聊天不强制横屏，不提交或发布。

## 实现边界

- `ArchiveOrientationPolicy` 为纯展示策略；首次进入保存原方向，游戏内切页面不重复覆盖恢复值。
- 只有可信同源活动 WebView 的当前文档能请求方向；隐藏旧页、旧 token、与原生 URL 不一致的刷新拒绝。会话游戏参数须唯一且有效。
- 原生 History API URL 更新及前端就绪状态同步策略，不重载 Activity、WebView 或聊天引擎。游戏期间旧角色 teardown 的 default 请求不能撤销横屏。
- 游戏页隐藏普通宿主顶栏/输入框，横屏舞台底部台词、联系人左栏/私聊右栏、安全边距与弹窗分别重排。
- 触屏选择人物不自动弹软键盘；主动点搜索输入才弹。短于 240px 的横屏键盘空间下，行动弹窗保留完整 44px 输入行与取消/发送，避免 footer 遮挡。

## 已执行证据

- `node --test tools/tests/chatarchive*.test.mjs`：292/292。`ordinary-contract-final.log`：27/27，普通生成/离线保护未改。
- Gradle `testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest`：37 秒 SUCCESS；104 Java 单元、0 失败；lint 0 error/7 warning。之后仅 instrumentation 代码变化重建 test APK/lint，46 秒 SUCCESS。
- `verify_apk_assets.py`：1848 资源条目、612 frontend 文件，原始字节及兼容转换的双哈希一致。
- `browser-final.log`：390×844、844×390、1440×900 各 light/dark，6/6，脚本/HTTP/网络失败 0。真实 1.1.11 媒体 + 合成 native/providers，不是原版 1.2.6 或真机完整性证明；包含 151px 行动输入可见区域断言。
- `ArchiveOrientationTest` 实际 API35 原生测试两项通过：大厅/舞台退出恢复、保留文档 History API 切换不重建状态、隐藏迟到调用拒绝。HTML 是合成场景，不读取玩家数据。
- 实际 APK 媒体/私聊键盘/Back 测试最终 **3/3 PASS**，见 `android-landscape-ime-settled.log`（31.485秒）。原生媒体为已校验的优香包，活动页自动转横屏，立绘和1280px背景实际显示；私聊、行动输入均在原生2272×394px / DOM866×151px键盘剩余区域。行动输入44px整行不被body/footer裁切；截图后仍保持键盘打开；返回先收键盘再关闭弹窗、同Activity/WebView，0生成。截图/JSON在 `output/chatarchive-r360/android-landscape-ime-settled-evidence/`。
- `android-landscape-final.log` 旧报告3/3，但当时行动输入JSON412px、截图无键盘，**不能用该旧 PASS 证明行动键盘场景通过**。复验修正的是测试：不在产品已自动聚焦时随动画重新点输入，稳定等待必须持续满足低高度条件；未放宽可见区域断言。

## 保留的失败与工具误差

- 旧 `loadDataWithBaseURL` 合成页并不更新真实 WebView URL；保留原失败，改测实际 loadUrl/History API，不放宽原生 URL 校验。
- 最初原生截图背景空白：测试地址 http://10.0.2.2 非安全上下文，实测 GET200/image/png/1679584 字节，但 crypto.subtle 缺失，缓存正确返回 `VN_ASSET_INTEGRITY_UNAVAILABLE`。改 QA 地址为可信 loopback http://127.0.0.1（adb reverse），保留摘要门槛，未把网络图片无验证放行。
- 测试 HTML 最初缺实际大厅布局/外宿主 overlay hook；这类 fixture 错误不称产品故障修复。当前 native fixture 用实际布局、native资源、touch/IME，但 outer Back hook/API/模型仍合成。
- 自动聚焦搜索导致人物选择被键盘遮挡、短输入弹窗 body 被挤压是确实观察到的 UI 问题，已改产品并复验。不能只检查 textarea 的外接矩形，还要验证 body/footer 的可见交集。
- Gradle test 资源目录的 lint 隐式依赖失败保留。所有 AndroidTest 任务声明 `syncArchiveTestAssets` 依赖后成功；fixture 只在测试 APK 中，不在主包。

## 未完成的整体门槛

R359 已拒收，不再推荐作完成交付。原 1.2.6 受保护 Hot 主玩法未恢复，完整等价未知；真实模型/CG/TTS供应商未实测；游戏域额外分支/记忆云备份未完成。普通完整运行时已另做双尺寸1101消息离线/切换/失败恢复 PASS，但旧一次无界等待未确立根因，浏览器冷开6–9秒也不是 Android 秒开证明。

当前 `.archiveqa360` loopback QA 包没有交手机用户，不能当正式联网验收包。本轮没有 commit/push/PR/正式部署、没有玩家账号/历史复用、没有保护绕过或媒体公共上传。

验证主包：88,219,813字节，SHA256 `9BCA97B6B16E9BB4D48C29099BFD80A0D4C05212CA2957B7D648C6D09B759EE7`；含可选优香starter，仅内部QA使用，不覆盖R359。测试fixture仅test APK。规划/Android分层/嵌入页面验收采用create-plan、android-clean-architecture、webapp-testing工作流；浏览器代理与Android原生证据分开。
