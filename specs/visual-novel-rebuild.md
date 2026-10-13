# 剧情剧场：独立重建实施记录

## 当前约束纠正：R356 也已被拒收

用户再次明确要求恢复 ChatArchive 原版工程，去掉导演模式、轻量化接入 Android 后验收；不是授权独立设计一套故事系统。R355/R356 都不能作为该目标交付，保留在本机仅用于历史证据，不再推荐安装或合入正式版。下文独立重建实现/测试记录不等于用户原目标完成。

当前计划：

1. 已完成本轮只读复核：`C:/CodexWork/chatarchive-recovery-126` 没有新增普通可读主业务工件；新增官方公开内容/文章渠道和 39 个发布元数据也没有取得源码。没有复跑同条件 VM 失败或用 stub 数量充成果。
2. **阻塞，需外部原版工件**：取得可验证的同版本原版主业务和工程依赖，证明实际方法体、资产绑定与构建可运行。缺少工程或必要授权时说明精确缺口，不擅自重建替代。
3. 待完成：在原版基础上移除导演模式并按需加载资源；接入现有 Android 模型、身份和本地优先存档，不增加普通聊天初始化负担。
4. 待完成：原版普通玩法逐项真机/实际模型验收、普通聊天回归、源码资产核验后才提供新的 APK。不提交、不发布。

风险和退出条件：现有 Hot 主业务仍未取得，普通运行不保证导出源码；低内存环境不降低安全门槛或关闭用户应用。保留累计工作区与本机存档，不删除拒收包/源码以掩盖错误。原版主业务未取得、未构建和未运行均属于未完成，不能被独立系统的 514 项测试替代。

## 2026-10-08 验收撤回与当前实施计划

R355 被用户拒收：它是历史会话的舞台阅读器，不是所要求的新游戏。下文原有“已完成”只记录旧阅读器检查，不能作为游戏交付结论。原验收包不再推荐安装，也不以旧测试数量代替新玩法验收。

当前实施范围：Android 内的独立游玩档案、从人物创建专用会话、人物私聊、约会事件、舞台推进、事件记忆与完整本地档案恢复。复用现有认证、计费、模型、官方预设与角色权限；不发布正式版本、不部署网站、不制作导演模式、不虚构地图关卡或关系数值。以下状态机是独立设计，不冒称恢复了原版工程。

1. 已实现并检查：游戏域与本机事务存储（完整 owner、gameId、人物会话绑定、分渠道回合、约会状态、记忆、分支备份）。
2. 已实现并检查：历史列表主入口替换为游戏目录和新游戏向导；可从无历史的角色创建，创建 POST 不自动重发，失败保留已确认绑定；可逐人添加专用会话。
3. 已修补并检查：接入原宿主生成并等待实际回合结束；上下文按游戏/人物/渠道/事件作用域投影，退出即清理，不污染普通聊天。真实 EventEmitter 吞异常的问题改为 provider 发送边界的 captured guard，使用真实事件实现和真实 sender 源码验证；先前合成事件器的异常传播不作为安全证明。真实供应商回包尚未实测。
4. 已实现并检查：独立人物线程、可持续约会与结束返回、共享世界设定、显式记忆摘录、存档备份/恢复；重开不自动生成。
5. 本机合成服务闭环已通过：新游戏→私聊→约会→舞台→记忆进入下一轮→退出重开→分支恢复，另有停止、重复点击、迟到回调、存储失败、账号隔离和普通聊天回归。不能将此项称为正式账号/供应商/真机全流程实测。
6. 最终本机验收完成：514 项回归、6 组明暗主题视口、Android 构建及源码/兼容产物双哈希核验通过。R356 只供本地手机验收；真实手机与供应商仍未测试，不发布正式版。

风险：不能把多个数据库的写入冒称跨库原子事务；canonical 会话是计费与云聊天记录，游戏域是本地权威事件档案。生成前先持久 pending，生成成功后完成回合；中断/重启保留未确认状态，禁止自动重发。恢复游戏分支不删除服务器会话或其他用户数据。受保护卡只保留授权标识，不拷贝世界书/预设正文。所有媒体按需，不打包原版大型素材。真实手机未连接和真实供应商未测必须如实注明。

验收门槛：不依赖旧历史就能创建并进入游戏；私聊/舞台/约会为独立持久内容；约会结束可回到原线程并留下事件；归档记忆会进入后续角色生成；重启/离线阅读及回滚不丢状态；停止/失败不伪造模型输出；所有按钮有真实状态变化而非只换标签页。

## R356 当前本地候选包与检查结果

- 文件：`D:/网站/验收包/惑梦-剧情剧场-20261008-R356-debug.apk`；源产物 `android-app/app/build/outputs/apk/debug/app-debug.apk`。
- 包名 `org.nebula.horizon.composeai.uireview`，versionCode 356，versionName `1.18.2-debug`，Android API 26 起。与正式版并存，不读取正式版私有存档；验收包需要自行登录。更新旧验收包不要先卸载，以免丢本机游戏数据。
- 大小 73,251,053 字节（69.86MiB），SHA-256 `6600447698F6699B9263FBF6237E5CC2D445242CC5C9CC38C1CD33494B6D7643`。
- 入口：我的 → 剧情剧场 → 开始新故事。大厅是独立游戏目录，不把旧历史自动改名为游戏。
- 新增三个模块：`visual-novel-game-store.mjs`、`visual-novel-game-session.mjs`、`visual-novel-gameplay.mjs`。游戏包含人物专用会话、分渠道回合、持续约会状态、共享世界、实际原文记忆、命名备份与恢复；没有导演模式或虚构等级关卡。
- 最终 28 文件 Node 联合回归 514/514，0 失败/跳过；发送边界专项 29/29。使用真实 EventEmitter 和实际 `sendOpenAIRequest` 源码，provider 为假 fetch，不访问真实服务。停止/旧会话/无法确认预设/宏/世界书错误及晚注入旧历史均被直接守卫阻止；明确拒绝不会被上层吞错伪装成成功。
- `webapp-testing` 的 server harness + Node Playwright 替代路径运行实际目录 HTML/控制器/游戏 store/session/gameplay/runtime；390×844、844×390、1440×900 明暗 6/6，0 控制台、脚本、请求失败和 HTTP 错误，168 个本机资源响应均成功。涵盖新游戏、单次创建、私聊、记忆、约会/选择、场景、备份恢复、重开、停止与明确拒绝文案。完整引擎仍由独立契约回归覆盖，不混称 Android 真机实测。
- Android `testDebugUnitTest lintDebug assembleDebug` exit 0：94 原生用例，0 失败/跳过；lint 0 错误、5 个既有警告。最终重新构建在 guard 与游戏错误文案修补之后；不是早先 464 项测试时的旧包。
- `python tools/verify_apk_assets.py` exit 0：1774 资源清单项、538 前端文件缺 0；原始文件逐字节、兼容文件的源码和产物双哈希均相符。独立必需列表新增三个游戏模块；OpenAI sender 与宿主注册同时核验入包。
- 当前使用 `android-app/local.properties` 指定的 `D:/Android/Sdk`。检查 `D:/Android/Sdk/platform-tools/adb.exe devices -l` 没有设备；先按旧笔记查询 E 盘工具失败，不计入真机验证。
- 所有累计更改保留。没有 commit、push、PR、正式 APK 覆盖或服务器部署。工作记忆补记“阅读器不等于游戏”和“事件异常不等于阻止请求”两项教训。

### 仍未完成的外部验收与明确限制

真实供应商生成、计费、图片/语音服务和 Android 真机尚未验收。游戏档案只有本机存储，尚无游戏域云同步、跨设备或导入导出接口；普通会话继续使用已有同步。原版完整工程、大型角色素材与未观察的私有机制未恢复，本包是独立重建，不宣称原版功能逐项复刻全部完成。

授权世界书关键词触发与角色文本宏尚不能完全按游戏分支回滚；系统消息合并或预设显式旧聊天宏会明确拒绝，不能将有限支持称为全卡/全预设无条件兼容。命名游戏存档不回滚服务器日志、卡片文件或外部扩展。

### R356 实际运行命令

工作目录 `C:/CodexWork/homer-sync-r354`：

```powershell
$vnTestNames = @('chatarchive-game-store','chatarchive-game-session','chatarchive-game-host','chatarchive-game-library','chatarchive-core','chatarchive-story-store','chatarchive-services','chatarchive-asset-cache','chatarchive-conversations','chatarchive-library','chatarchive-reader-lifecycle','chatarchive-presentation-routing','chatarchive-host-contract','chatarchive-outbox-batch','chatarchive-browser-evidence','mobile-r354-local-session','mobile-r354-local-runtime','mobile-r34-cloud-sync','mobile-r41-host-control-display','mobile-r40-card-transport','mobile-r40-card-transport-cache','mobile-r41-card-transport-overlap','mobile-r41-card-transport-candidate','mobile-r354-generation-guard','mobile-r32-model-gate','mobile-r29-generation','mobile-r34-stream-forward','mobile-r37-model-read')
$vnTestFiles = $vnTestNames | ForEach-Object { 'tools/tests/' + $_ + '.test.mjs' }
node --test @vnTestFiles
python C:/Users/ROG/.codex/skills/webapp-testing/scripts/with_server.py --server "python tools/tests/chatarchive_browser_fixture.py --port 8789" --port 8789 -- node tools/tests/chatarchive_game_browser_checks.mjs
python tools/verify_apk_assets.py
```

工作目录 `C:/CodexWork/homer-sync-r354/android-app`：

```powershell
.\gradlew.bat --no-daemon '-Dorg.gradle.jvmargs=-Xmx768m -Dfile.encoding=UTF-8' testDebugUnitTest lintDebug assembleDebug '-PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview' '-PHOMER_DEBUG_VERSION_CODE=356'
```

最新完整流程证据在 `output/chatarchive-game-browser/results.json`；单独大厅/API 合成用例在 `output/chatarchive-game-library-browser/results.json`；验收使用说明在 `output/chatarchive-R356-acceptance.md`。

2026-10-08：用户允许“能解决就解决，不能解决就重新做”，替代此前必须恢复原版工程的单一路线。本实现不是 ChatArchive 原作者源代码，也不宣称精确复原未观察到的 1.2.6 私有行为。

## 证据与边界

- 原版包的主业务工程未恢复；不能以启动素材或空方法当作完整工程。
- 官网公开描述大厅、AI 对话、档案、CG、私聊、约会、群聊、TTS、自定义角色及参数设置。公开教程数据目前为空，精确推进和存档行为未知。
- 本次在 Android 的现有常驻对话引擎上独立实现。不创建第二个聊天引擎或 Unity 运行时；大厅沿用现有多页面常驻 WebView 导航，舞台挂在既有聊天页。不改正式服务器，不发布，不复制未经确认许可的游戏角色资源。
- 导演模式不进入入口、路由、生成动作或快捷键。

## R355 旧阅读器实施记录（已撤回，非当前游戏交付结论）

1. 已完成：宿主契约与 clean-room 规格；保持已有累计修改。
2. 已完成：完整分段时间线、稳定锚点与账号/会话隔离的本地呈现存储。
3. 已实现并通过本机合成界面检查：剧情舞台、揭示/推进、回看、自动/快读、输入、阅读书签与设置；完整剧情恢复使用原地宿主与原子 outbox。真实 IndexedDB 界面测试覆盖快照存储与合成恢复，正式宿主的原地恢复/原子 outbox 由 VM 契约回归覆盖，不能合称完整 Android 引擎实测。
4. 已实现：按需板块入口，复用既有完整会话、模型、停止、预设和记忆；Android 路由保留新板块，不另开聊天引擎。
5. 已实现：普通私聊、约会邀请、联系人/群聊、角色档案、CG/TTS 的既有服务适配。服务合成契约通过，不等同于真实供应商已验收；既有群协议限制另列。
6. 已完成本机检查：离线/重启、迟到回调、候选修改、账号隔离、停止并发与普通聊天回归。最后的原生页面可见性与大厅缓存守卫已补测，联合 390 项检查通过。
7. 已完成本机验证与最终打包：390×844、844×390、1440×900 内嵌界面 13 个功能场景均通过；保留 1 个 Chromium 媒体诊断，不宣称网络零失败。最后守卫修补后的 Android 单元、lint、debug 构建及 APK 资产核验通过。
8. 已保存本地验收 APK 与交付说明，记录实际限制；不提交或发布。真实手机与真实供应商仍待验收，不称为原版完整复刻或线上全功能验收。

## 关键验收语义

- 点台词揭示/下一段只变呈现，不请求生成、不扣费；生成下一回/发送/选择显式走原宿主守卫。
- 原消息不截断、不由舞台文字替代；修改、删除、候选变化后核对锚点，不按旧数组下标套用。
- 本机成功必须以事务完成为准；读取失败显式反馈，不把内存缓存冒充持久存档。
- 阅读书签是位置，不是完整剧情分支存档。完整故事快照/分支另需宿主事务，未实现不得称为完成。
- 普通聊天没有剧情资源下载、计时器或画布；舞台退出/换账号停止音频及过期任务。
- CG/TTS 只有实际服务调用通过才算验收；无服务不能用固定图片或音频冒充。
- 新界面用软件现有主题和安全区；第三方精确视觉未知，独立设计不标“原版复刻”。

## 风险与验证

Web 装配树已有约 740 条累计工作区记录。禁止重新 bootstrap、reset、clean 或整树替换。测试使用合成数据和本机预览，不读取用户账号/历史，不调用正式生成服务。低内存的模拟器测量与浏览器代理测量分开，未完成真机测试不称已通过。

官网来源：[首页](https://chatarchive.com.cn/)、[公开功能数据](https://chatarchive.com.cn/content/data/home.json)。更详细的已分级证据保留在 `C:/CodexWork/chatarchive-recovery-126/BEHAVIOR-SPEC.md`，旧版原版恢复阻塞记录只作为历史，不再阻碍用户现已授权的重建。

## 验证证据

- 19 套剧情/原子存档/旧存储/卡片传输/证据落盘组合检查：390/390 通过。LRU 同毫秒排序、重启、跨实例及系统时钟回拨均有固定时钟检查，未用延时掩盖。
- 本机浏览器：390×844、844×390、1440×900，明暗主题共 6 组布局/存储/停止测试；选择重复保护与账号隔离、完整剧情备份恢复、停止等待中的生成、CG 生成/删除、语音播放/停止、IndexedDB CG/素材离线恢复、宿主隐藏/再显示与本地保存另 7 组功能通过。最后一轮 13 个功能场景全部通过，但存在 1 个 Chromium `ERR_ABORTED` 诊断（CG-offline 合成头像 GET），进程按严格门槛返回 1，不将此轮网络检查描述为零失败；最新证据每次覆盖在 `output/chatarchive-browser/results.json`，不复用旧成功报告。
- 固定诊断样本另执行 8 个选择流程、24 个 GET，保留 1 次 PW/CDP `ERR_ABORTED`。同一请求实际 HTTP 200、完整读取 68 字节、SHA 校验正确、取消信号未触发、图片已显示并写入真实 IndexedDB。没有应用先取消的证据，且上游根因尚未证明；不扩大“预期取消”过滤，不用反复运行直至偶然零错误作结论。详细关联记录在 `output/chatarchive-reader-transport/results.json`。
- 大厅实际 HTML/控制器/布局在 390、1440 浏览器检查通过，含账号切换、搜索、分页、私聊路由及群弹窗取消；控制台/网络错误为 0。聊天目的页在此组仅检查路由，宿主引擎由独立契约回归覆盖。
- 原生页面可见性经父页/来源/完整会话 ID 与私有账号 epoch 守卫进入舞台。离页暂停翻页、RAF、音频及过期媒体；回来不自动播放/生成。`current()` 仍只表示会话有效性，已排队书签及完整剧情保存不因隐藏丢失。真实 Android 切页仍需真机验收，浏览器用直接方法调用和真实 IndexedDB，宿主转发用 VM 契约回归。
- 大厅不读取/写入会被既有缓存截断的超长账号键；同前 160 字符的两个完整账号有负面回归。缓存只保存最多 100 条、24h 有效的元数据，不等于完整 canonical 档案索引；索引过期或未同步时离线不能枚举所有旧故事，但不会删除它们。
- Android `testDebugUnitTest lintDebug assembleDebug` 通过，94 个原生单元用例通过；lint 0 错误、5 个既有警告。首次 `.uireview` Gradle 参数因 PowerShell 未整项加引号被拆成任务，重新以整项引号执行后构建通过。当前候选包约 69MiB、1771 资源、535 前端文件缺 0，原始资源/兼容产物双哈希检查通过。
- Python Playwright 两个包源均 TLS 失败，按可验证替代使用本机已带的 Node Playwright/Chromium；没有关闭证书校验。
- 1101 条合成消息首次浏览器构建约 83–138ms、复用更新约 1–4ms；这是桌面浏览器测量，不代表 Android 真机速度。
- 群聊既有后端只提供最近 50 个群、最早 300 条消息，没有分页参数和总数；客户端不能冒称取到完整群聊历史。发送失败也可能已保存用户消息，必须显示未确认并先刷新核对，禁止自动重发。
- 真正模型/图片/语音供应商尚未调用；不能将合成回包算作真实供应商成功。
- 当前 `adb devices -l` 没有连接设备；未启动高内存模拟器。不能将 Android 编译/单元成功称为真机验收。

## R355 撤回的旧验收包（不要继续交付）

- 文件：`D:/网站/验收包/惑梦-剧情剧场-20261008-R355-debug.apk`。
- 包名 `org.nebula.horizon.composeai.uireview`，versionCode 355，versionName `1.18.2-debug`；Android 8.0 / API 26 起。
- 大小 72,699,830 字节（69.33MiB），SHA-256 `F7C6EF614CFFC1D9E78BD61C5BA02B00B31404A125ED523E878E3BD128956957`。
- 来源构建产物与交付副本 SHA-256 相同。1771 资源条目、535 前端文件缺失 0；源码/兼容产物双哈希相同。
- 入口：登录后“我的 → 剧情剧场”。本包与正式版并存，不读正式版私有本地存档；需要在验收包内登录。它使用已有联网服务，但本轮未访问真实账号、会话或供应商。
- 只按需加载选中场景素材，没有打包原游戏大资源，也没有导演模式。舞台沿用当前角色与完整会话，不新建第二个生成引擎。
- 全部源码留在 `C:/CodexWork/homer-sync-r354` 及其 `.web-cache/tree` 装配树。原来 740 条累计工作区记录均仍保留，未 bootstrap/reset/clean，没有提交、推送或正式服务器更新。

## 实际运行命令

工作目录 `C:/CodexWork/homer-sync-r354`：

```powershell
node --test tools/tests/chatarchive-core.test.mjs tools/tests/chatarchive-story-store.test.mjs tools/tests/chatarchive-services.test.mjs tools/tests/chatarchive-asset-cache.test.mjs tools/tests/chatarchive-conversations.test.mjs tools/tests/chatarchive-library.test.mjs tools/tests/chatarchive-reader-lifecycle.test.mjs tools/tests/chatarchive-presentation-routing.test.mjs tools/tests/chatarchive-host-contract.test.mjs tools/tests/chatarchive-outbox-batch.test.mjs tools/tests/chatarchive-browser-evidence.test.mjs tools/tests/mobile-r354-local-session.test.mjs tools/tests/mobile-r354-local-runtime.test.mjs tools/tests/mobile-r34-cloud-sync.test.mjs tools/tests/mobile-r41-host-control-display.test.mjs tools/tests/mobile-r40-card-transport.test.mjs tools/tests/mobile-r40-card-transport-cache.test.mjs tools/tests/mobile-r41-card-transport-overlap.test.mjs tools/tests/mobile-r41-card-transport-candidate.test.mjs
python C:/Users/ROG/.codex/skills/webapp-testing/scripts/with_server.py --server "python tools/tests/chatarchive_browser_fixture.py --port 8789" --port 8789 -- node tools/tests/chatarchive_browser_checks.mjs
node output/chatarchive-library-qa.mjs
python tools/verify_apk_assets.py
```

工作目录 `C:/CodexWork/homer-sync-r354/android-app`：

```powershell
.\gradlew.bat --no-daemon '-Dorg.gradle.jvmargs=-Xmx768m -Dfile.encoding=UTF-8' testDebugUnitTest lintDebug assembleDebug '-PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview'
```

Node 联合回归 exit 0 / 390 项通过；大厅浏览器检查 exit 0；阅读器 13 项功能通过但因保留的 1 个网络诊断 exit 1；Gradle exit 0 / 94 个原生用例、lint 0 错误 5 个既有警告；资产核验 exit 0。图片/音频合成回包用于 API 适配与播放/持久化验证，不冒充正式模型输出或真人语音。
