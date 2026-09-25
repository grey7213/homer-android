# R27：手机源码外露与模板标题回归（2026-09-25）

## 结果和产物

- 当前客户端源码：`C:/CodexWork/homer-community-r9`；Web/运行时：`.web-cache/tree`，保留此前累计成果。本地验收阶段未部署生产；后续提交 PR 不代表已合并或上线。
- Debug `org.nebula.horizon.composeai.uireview`，versionCode 310，可覆盖同签名的上一轮本地验收包，不需要卸载或清数据。
- 交付目标：`D:/网站/惑梦-R27-旧存档渲染修复-v310.apk`。
- APK SHA-256：`A625A4F792AC4B4CD3367193FC5630AA241B6ED0AFE00C311B0821DB0CF6D222`。
- 本机测试服务仍需电脑在线，手机能访问同一局域网；不是正式服包。用户实体手机未连接，不宣称真机已通过。

## 原因和修复边界

1. 上一轮直接用 `chat.html?app_id=...` 启动，未覆盖实际 `conversations/start` 的开场播种路径。后者在后端执行显示正则，保存约 14717 字符 HTML；模板内部仍有 `LOADING...`，前端再执行同一正则时把整页嵌入自身，拆散围栏、露出余下源码。真实接口及旧 APK 均已复现，与截图同类；不是缺少酒馆助手。
2. 新会话只在服务端执行源文本阶段的规则；显示阶段留给运行时，提示词专用规则不混入开场。普通源文本规则没有一刀切关闭。
3. 旧会话开场只在与当前固定版本的已渲染完整文档**完全一致且来源唯一**时，恢复源开场再显示；不清空历史、不用新版卡强盖旧版本，不改用户编辑和普通代码。含随机、时间、变量等状态宏的未知旧内容不尝试重放，避免识别过程改变变量。
4. 角色编辑器加载/保存会保留正则 placement、markdownOnly、promptOnly、runOnEdit、深度、替换宏和裁剪等元数据；此前表单映射会丢这些字段。
5. 工坊入口去掉“正则与效果预览”第二行；资源列表和编辑页短标题统一为“界面模板”。旧 regex 路由、记录和版本仍兼容，非另建功能。

## 命令与证据

```powershell
node --test tools/tests/mobile-r25-resources.test.mjs tools/tests/mobile-r25-runtime.test.cjs tools/tests/mobile-r26.test.mjs
py -3.13 -m unittest discover -s tools/tests -p 'test_mobile_r*_host.py' -v
py -3.13 tools/tests/mobile_r27_e2e.py --credentials <本机凭据文件> --output output/mobile-r27/final-browser
# android-app，JDK21，SDK35
.\gradlew.bat testDebugUnitTest lintDebug assembleDebug '-PHOMER_DEBUG_SERVER_BASE_URL=http://172.24.5.154:8086/' '-PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview' '-PHOMER_DEBUG_VERSION_CODE=310'
py -3.13 tools/verify_apk_assets.py
# 在旧309包建立隔离验收存档，并复现可见源码；再覆盖安装310包
node tools/tests/mobile-r27-android.cjs --seed-old
node tools/tests/mobile-r27-android.cjs
```

- Node 18/18；服务端 12/12。Python 既有测试仍有 unclosed SQLite ResourceWarning，断言通过。
- 修改前真实 start API 回归失败：`startSourceVisible=1`，`seedLength=14717`。修改后为 0 和 10，保留源开场 `LOADING...`。
- 浏览器 390×844、1440×900：真实 start、旧格式精确恢复、重载、切换开场、开始游戏→身份选择、编辑器元数据、工坊单行与短标题通过，脚本异常 0。网络记录见最终 JSON，不掩盖资源回退/正常取消。
- Android API35：旧309包 `sourceVisible=1`；新包同一存档 `sourceVisible=0`，原始开场恢复，候选顺序和会话 ID 保留。重开历史、游戏交互、单行四入口、长记忆可用均通过。截图在 `output/mobile-r27/android`。
- 最初截图只等 iframe 插入即拍，出现还未排版的空框；已加强测试，等待内部文字、完整高度及布局一致再截屏，最终图片已人工查看。不能用“源码没了”代替“内容已显示”。
- 工坊四标题实测高度 16.90 CSS px，行高 16.9，均为一行。深浅样式沿用当前主题，不修改无关界面。
- Gradle unit/lint/build 成功，lint 0 errors / 5 既有 warnings。APK 1192 资源条目，180 前端文件缺失0，源码与包内资源逐字节一致。
- 本轮没有重新改加载架构或声称全局秒开。大卡交互后长记忆测试包含自动化往返的样本约 1.58/2.27 秒，不能拿它与简单卡的页面内计时直接当同口径性能结论。
- 追加 WebView 内部 `performance.now()` 测量（可见且内容填充的长记忆界面）：450/1120/995ms。不是固定毫秒承诺。
- 网络门禁未通过：一次 `/module/dialogue/api/homer/session` 502；复核又出现 `/module/dialogue/api/homer/sync` 与 `/module/dialogue/api/homer/runtime-state` 502。功能断言通过不代表同步请求全部成功。运行时日志有 `This operation was aborted`，现有转发超时为3秒；复核期间也执行了原生截图测试，不能称为完全隔离串行负载。未修改全局超时、吞错误或宣称网络零故障。后续需单独测大卡同步与测试服务负载，当前保留这一限制。
- Android最终操作回归长记忆（含自动化往返）样本1715ms。已确认包版本310，本进程AndroidRuntime错误日志为空。游戏身份页按钮可达，但未验收卡内全部玩法、第三方API与全部绘制效果。

## 完整源码交接

- `web-patches/20260925-2328-complete-web-mobile-r27.patch`：112文件，完整累计补丁；在隔离 Git index 从锁定 pin `02069118baa83354f3e01a6d0021562111211373` 应用后与当前客户端树一致。
- 旧 R26 补丁移至 `output/mobile-r27/superseded-r26.patch` 可恢复，避免重复应用。
- `server-patches/mobile-r26/mobile-r26.patch` 沿用原交接路径，但内容已含 R25–R27；原服务器源码未改，只在隔离服务副本运行。相对 D 项目原基线 `git apply --check` 通过。不要叠加旧累计补丁。
- 不含密码、Cookie、token或签名材料。没有收费生成、模型扣费或生产验证。
