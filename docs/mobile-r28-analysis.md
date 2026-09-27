# R28：正式版启动、安装身份与生成延迟

## 范围与证据

2026-09-26，仅分析用户提供的本地 APK 和官网下载的惑梦正式包。未使用第三方账号抓取私密数据，未绕过鉴权，未复制竞品实现到项目中，未发起付费模型请求。

| 样本 | 版本 | 包名 | SHA-256 |
| --- | --- | --- | --- |
| 官网惑梦 | 1.15.5 / 275 | org.nebula.horizon.composeai | B7095671C7D4625E8981BF07E4906C42818CD35EFD810F87D81A26191A2E3F0C |
| 风月.apk | 1.15.14 / 292 | org.nebula.horizon.composeai | 2D9B2627C8256D97E7252A53E9819AD8150DACAD1C211C44A0C63222694DDF9D |
| tavo最新新新.apk | 1.6.1 / 1061 | app.bitbear.tav | 16C12A871728AE06CEE7025D77A005131F53BB5664E78616DCAFBE8001919EF5 |

正式样本来自 `https://patcher.villainy.top/download/homer-android-1.15.5-275-release.apk`，不是本地 R27 测试包。APK、反编译产物和浏览器证据仅保存在 ignored `output/mobile-r28/`。

## 安装冲突：已确定根因

惑梦与风月的 applicationId 完全相同，签名证书不同：

- 惑梦正式证书 SHA-256：`429b4165d958750c1fa90289c23b6d9b6d45ff915b535c5b1fbc72d52d93f320`。
- 风月证书 SHA-256：`9c7781b12217c32aca114f6167235baa43ca9188aba6868bd6979ba95853ec24`。

Android 把二者视作同一应用的不同签名更新，因此拒绝安装；改显示名称或重新签一个名无法解决。R28 将正式 applicationId 改为 `app.huomeng.homer`；debug 为 `app.huomeng.homer.debug`。FileProvider authority 继续从 applicationId 派生，更新校验继续严格比对当前包名和正式签名。

迁移边界：新包是独立应用，不能覆盖旧包，不能直接读取旧包私有数据。不要卸载旧版；新包登录同一账号恢复服务器已有数据，未同步的纯本地存档必须先通过旧版导出/同步。不能承诺所有本地资料自动迁移。正式发布沿用惑梦正式签名，不使用风月签名。

发布必须同步更新官网 release.json 的 canonical、不可变文件条目和 package，发布脚本若硬编码旧包名也需调整。旧版自动更新器会拒绝新包名，这是正确的安全行为；迁移需提供官网明确的新应用下载入口，不能关闭包名校验来强装。

## 白屏：已修复的代码缺陷与边界

1. 现有传输层无条件调用 `AbortSignal.throwIfAborted()`。缺少这个 API 的网页组件会在 fetch 发出前抛 TypeError，随后被误报为网络失败。浏览器故障注入已复现：实际请求次数为 0；补丁后请求成功发出一次。
2. 发布流程以前直接打包现代 JS，没有 Android 网页组件兼容目标。新增仅作用于 APK 的 Chromium 89 编译步骤，并在完整 HTML 的首个脚本之前加载标准 API 与 DOM 兼容层。原 Web 真源不覆盖。旧版 AbortSignal、数组方法、对象方法、Promise、克隆、UUID、dialog 等补齐；不同引擎不替换原生 fetch，也不关闭 TLS 校验。
3. 原生创建 WebView 发生在 setContentView 之前，缺少 provider 异常处理。现先创建原生可显示容器；网页组件不可用时提供说明和重试，不清账号、不清聊天数据库。
4. 增加所有网页容器的渲染进程退出处理：移除并销毁被系统回收的 WebView，清引用，展示原生恢复界面。非对话页加载失败不再切到一个空对话快照。
5. 离线快照去除未受兼容层覆盖的 Array.at；预热移除不必要的 Set.of 依赖。

原始对话运行时使用 top-level await；最低 Chromium 89 来源于 [V8 官方版本说明](https://v8.dev/blog/v8-release-89)。更旧内核不能用普通 API polyfill 补出模块语法支持，会显示更新网页组件的说明，**不等于已在不升级网页组件的前提下支持这些机型**。Android 8 本身不必升级，只要其可用的 WebView 内核满足要求。

渲染进程退出处理遵循 [Android 官方说明](https://developer.android.com/develop/ui/views/layout/webapps/handle-termination)。

用户报告设备为“华为8manx”，没有该手机的 WebView 版本和现场日志。因此已证明存在兼容缺陷，但不能把它断言为该手机的唯一根因，更不能宣称该手机已实测修好。旧 CSS 特性、厂商内核差异及第三方角色卡动态脚本仍需设备覆盖。

## TAVO、风月如何降低等待与卡顿

以下是静态行为分析，不是同模型网络跑分；没有编造它们的首字延迟毫秒数。

### TAVO 1.6.1

- APK 是 Flutter/AOT 主体，包含本地 H5 消息渲染模块和本地数据库相关组件；不是每次进入聊天重新下载整个网页。
- 最新 H5 bundle 可确认 `append`、`final` 的流式消息操作：追加内容和最终内容分开处理；渲染会话保留状态，而非每个片段重建整段界面。
- `streamingOutputEffect` 控制不同质量档。中档走 rawText，低档走 noText，最终阶段再完成渲染；这是减少流式过程计算/布局成本的权衡，不是所有档都具有同样丰富效果。
- 消息包包含 epoch/sequence。序号不连续时请求 streamingSnapshotRequested，避免丢失片段后显示错误状态。
- AOT 中还存在“流式时不执行正则，减少复杂正则卡顿/耗电”的设置说明。此条属于字符串证据，不能仅凭它认定所有模式都关闭正则。
- 网络层核心在 AOT 中，未完成同接口动态抓包，无法确认每类模型请求是否直连，也不能据此宣称有特殊加速通道。

### 风月 1.15.14

- Native Kotlin/Compose + 本地 H5，不是 Flutter。使用单例 OkHttp 客户端；流式读超时为 120 秒，普通请求为 30 秒。超时变长只是容忍生成等待，不会让模型推理变快。
- 聊天读取 SSE 并更新消息。可读的 `ChatViewModel$sendMessageStreaming...` 路径使用 StringBuilder 合并片段，约超过 1 秒或积累 300 字符时触发一次 updateStreamingMessage，结束时处理剩余内容。这是减少界面刷新频率，甚至可能增加少量显示延迟，不是每字都最快显示。
- 同一 APK 还有较新的 ConversationViewModel、前台流式服务和待恢复流状态；不能把上面一个 ViewModel 的阈值泛化为所有对话路径。
- 单例网络客户端可以复用连接，SSE 解析与界面更新分离。风月同样依赖远端模型，不是在手机上本地完成这些模型生成。
- JADX 部分协程反编译失败；报告只依据成功读取的分支，不把缺失实现补猜成事实。

### 惑梦目前的区别

已检查本地当前客户端和暂存后端，尚未证明正式服务器部署源码与其完全一致。

- 当前对话桥已经强制 `stream_openai=true`；链路为客户端 → 对话运行时 → 站点计费/鉴权后端 → 上游模型。运行时 forwardFetchResponse 转发流，站点 OpenAI 兼容路由每个内容片段 write + flush。不能笼统说惑梦完全没做流式。
- 相比单一请求通道，额外桥接、会话鉴权、提示词/世界书/脚本处理会增加首字前准备成本；大上下文也会增加上游处理时间。具体谁占大头必须测量。
- 站点上游访问使用每次 `urllib.request.urlopen`，没有看到类似风月单例 HTTP 客户端的显式连接池设计。
- **另一个旧 web-chat 分支**遇到正则/数据库等处理会先收完整回复再加工，最后分片发出。这会出现“等很久才显示”；但当前 SillyTavern 兼容流路由不是该分支，不能未经请求路径确认就拿它解释所有正式用户的延迟。
- 后端排队、模型思考时间、供应商负载、输入 token 数和网络线路，客户端无法凭换 UI 消除。

## 可独立实现的行为规格（本轮仅分析，不偷改模型链路）

1. 点击发送立即本地显示用户消息和可取消的生成状态；不伪造模型内容。
2. 分开记录点击→请求、请求→响应头、响应头→首内容片段、首内容→首绘制、完整输出五个时间，不把空 role 帧当首字。
3. 复用服务端 HTTP 连接；SSE 逐片转发，反向代理关闭响应缓冲，取消请求向上游传播。付费写请求不静默重发。
4. 界面按短帧窗口批量更新已有消息节点；普通文字先展示，复杂正则/卡片界面在合理阶段处理，最终内容必须一致；不能以永久关闭正则破坏角色卡。
5. 会话 epoch、序号和取消状态隔离；旧流不写入新会话，断流可明确恢复，结束时刷新最后片段并保存。
6. 同一设备、同模型、同供应商、同提示词/长度、同网络至少重复多次，对比中位数和高分位；区分冷连接与连接复用。未完成这组实验前，不报告 TAVO/风月“请求延迟是多少”。

## 证据定位

- 惑梦：`android-app/app/src/main/java/.../HomerActivity.java`、`tools/webview-compat/`、前端 api-transport、homer-bridge、运行时 chat-completions、暂存后端 stream_sillytavern_bridge_completion。
- 风月：ignored `output/mobile-r28/wind-jadx/.../NetworkModule.java`、`SseParser.java`、`ChatViewModel$sendMessageStreaming$1$6$1$5.java`。
- TAVO：ignored `output/mobile-r28/tavo-assets/assets/flutter_assets/assets/dist/js/bundle.min.js` 和 AOT 字符串；没有将第三方原实现纳入交付源码。
