# R26 本地软件验收记录（2026-09-25）

## 产物和边界

- 源码：`C:/CodexWork/homer-community-r9`，分支 `fix/mobile-workshop-performance-r25`；保留 R25 累计改动。
- APK：debug 独立包 `org.nebula.horizon.composeai.uireview`，versionCode 309；连接本电脑隔离测试服务 `172.24.5.154:8086`，手机须能通过同一局域网访问。不是正式服包，不要求卸载正式软件。
- APK SHA-256：`D504D25B4381944BA0FC525731C920FD67305E2D99AB457485A72BA9235706C7`。
- 交付位置：`D:/网站/惑梦-R26-本地验收-v309.apk`，复制后已再次核验 SHA-256 一致。
- 没有 commit、push、PR、生产部署；正式账号、积分和数据库未更改。

## 按需求完成的链路

1. **保持 R25 速度路径**：没有改回整页刷新。原生持久主页面、预热聊天、同一 WebView 会话切换继续使用。
2. **界面模板就是正则**：一个入口、同一列表、同一编辑/文件导入/预览。旧 `regex` 和新 `ui_template` 资源一起列出，旧 ID/版本类型不迁移；角色作者的选择与会话实际正则绑定均兼容两种记录。旧纯 HTML 资源无损保留，不伪造全匹配规则。
3. **酒馆助手与案例卡**：现有包已含 TavernHelper 4.8.19，不是再次安装一个同名扩展。修复 HTML 围栏被 Markdown 拆散、已接管源码在助手 CSS 失效时暴露、云端开场遗漏备用候选、开场切换后宿主页未释放生成状态。提供仅在有多个作者开场时显示的切换控件，末尾不触发付费生成；有后续消息时沿用确认逻辑。
4. **实际发现的后端截断**：案例卡第二开场界面约 302 万字符，旧规范化只留 24 万；导入、投影、全局正则统一改成 8 MiB UTF-8 限额内完整保留，超限报错，不截半份脚本。旧数据只在同版本原快照能证明截断时安全恢复，不覆盖编辑。
5. **扩展间解析冲突**：代码块虽禁用 EJS 执行，但旧字符串包装仍被后续思考标签处理再次改写。代码块现在作为不解析的占位通过处理链，结束后还原；正常代码和显式启用的模板执行不一刀切关闭。源码和已打包 vendor bundle 同步，机械同步脚本对不认识的基线会失败。
6. **右上角设置**：对话能力/扩展与外观分组；模型参数直接调节，名称/价格分行；预设、搜索、统计统一任务页；Mod 筛选和单层滚动；长记忆常用操作前置。深浅主题、返回、取消、保存、Android 返回键已逐页验证。补齐菜单刷新保留打开状态与空状态文字对比度。没有改变聊天内容的作者设计。
7. **标签反馈**：详情标签长按菜单，点赞加权、不感兴趣降权、屏蔽在排序前过滤；三者互斥，支持撤销、容量/保存失败反馈、账户隔离。拖动/滚动取消长按。探索缓存保留原始候选，返回即可重新排序/过滤，撤销不须重新取数。社区公共推荐也接入，个人管理/直达详情不隐藏。

## 证据和命令

```powershell
node --test tools/tests/mobile-r25-resources.test.mjs tools/tests/mobile-r25-runtime.test.cjs tools/tests/mobile-r26.test.mjs
py -3.13 -m unittest discover -s tools/tests -p 'test_mobile_r*_host.py' -v
py -3.13 tools/test_export_web_patch.py
py -3.13 tools/tests/mobile_r25_e2e.py --credentials <本机凭据文件> --output output/mobile-r26/regression
py -3.13 tools/tests/mobile_r26_e2e.py --credentials <本机凭据文件>
py -3.13 tools/tests/mobile_r26_card_e2e.py --credentials <本机凭据文件>
# android-app，JDK 21 / Android API 35
.\gradlew.bat testDebugUnitTest lintDebug assembleDebug '-PHOMER_DEBUG_SERVER_BASE_URL=http://172.24.5.154:8086/' '-PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview' '-PHOMER_DEBUG_VERSION_CODE=309'
py -3.13 tools/verify_apk_assets.py
# 安装到 API35 模拟器、转发 WebView 调试端口后
node tools/tests/mobile-r25-android.cjs
node tools/tests/mobile-r26-android.cjs
node tools/tests/mobile-r26-card-interaction.cjs
```

- Node 16/16；服务端 10/10；补丁导出工具 2/2。
- 浏览器 390×844、1440×900：标签、设置深浅主题、模型选择/取消、Mod 搜索、真实案例卡通过。页面脚本异常 0；默认测试头像 404 有内置回退，离开时模型状态请求取消为预期。不是把这些记成完全没有任何网络记录。
- R25 浏览器回归也通过；其中 conversation 请求的 `ERR_FAILED` 是测试主动注入断网，用来验证离线历史缓存，不是自然发生的请求故障。
- 案例卡真实互动：首开场 → 第二开场 → 开始游戏 → 身份选择。浏览器及 Android 都通过，源码块不可见、EJS 错误提示 0；未点击作者的插件安装按钮，未发起付费生成。
- Android 全页截图（含系统栏）在 `output/mobile-r26/android`；原生菜单、模型、预设、记忆、Mod、外观、搜索、统计、标签长按/撤销均有截图和交互记录。视觉仍待用户认可。
- Gradle 成功，lint 0 errors / 5 既有 warnings；最终 APK 1192 资源条目、180 个前端文件缺失 0，与当前打包源逐字节一致。
- 完整累计 Web 补丁 `web-patches/20260925-2240-complete-web-mobile-r26.patch`，112 文件；在隔离 index 上从 pin `02069118baa83354f3e01a6d0021562111211373` 应用后与当前客户端树一致。旧中间补丁移至 output 可恢复，避免重复应用。服务端四模块补丁另见 `server-patches/mobile-r26`。

## 性能与已知限制

- 最终 API35 模拟器样本：返回已打开主页面 57–488ms、返回已有聊天 171ms、长记忆 291ms；已预热后绑定新卡 4557ms。首轮页面样本 222–2755ms。样本受主机负载、卡数量/大小影响，不是所有入口都保证秒开；没有用遮住加载或假消息代替可交互检查。
- 最后一次 R26 深浅主题回归：长记忆分别 307ms / 238ms；标签屏蔽、无刷新撤销、模型保存恢复、案例卡及历史重开均通过，失败列表为空。
- 自动化曾误把新 WebView 的 about:blank 当就绪，过早离开导致真实页面脚本被测试中止。已改为核对文档路径、可见内容和初始化状态，再重跑通过；不能把旧错误样本当速度成绩。
- 原手机截图的精确触发条件未复现，不能断言它只有一个原因。本轮修的是上述可复现的通用缺陷，并验证指定卡互动；不承诺未经验证的所有第三方卡和外部网络依赖。
- 标签反馈使用现有本机按账号存储的推荐偏好；不声称跨设备云同步或训练了新的机器学习模型。作用于现有已鉴权候选集，不改变服务端全库排序。
- 没有连接用户实体手机，没有测试收费模型生成/自动总结扣费或生产发布。本机测试包依赖当前测试电脑在线；正式更新还须同步服务端补丁。
