# R22 验收与交付（2026-09-19）

产物：`D:\网站\惑梦-管理员搜索长记忆R22-293-debug-20260919.apk`。
包名 `org.nebula.horizon.composeai.uireview`，versionCode 293，versionName `1.15.2-debug`。
源码 `C:\CodexWork\homer-community-r9`；内置前端来自该目录的 frontend/runtime 联接树。仍连接既有 `https://patcher.villainy.top/`，未部署或提交生产。

## 本轮修正

- 我的：管理员判断独立于积分、人设请求；正确解包 `data` 形式的个人资料；权限请求失败/超时提供就地重试，不从本地缓存授予管理员。
- 搜索：暗色输入文字区域透明，使用同一个父级背景。静止、聚焦、输入、失焦均无拼接色块。
- 长记忆：撤掉 R21 额外添加的预览范围/下一步页面；直接使用原插件当前会话数据、范围标记和生成操作。启动未完成时可取消待打开操作，关闭后不自动弹出、不自动生成。
- 在安装包实测中补修原插件英文按钮回退和嵌套滚动问题。保留实际按钮和处理函数。

## 已执行并通过

- `py -3.13 tools/verify_ui_r22.py`：390×844、1440×900；挂起积分与人设时管理员入口仍显示；缓存管理员但服务器普通用户时隐藏；权限请求失败重试；搜索 rest/focus/blur 背景和文字对比度。
- `py -3.13 tools/verify_memory_host_r22.py`：实际外层 chat.html、实际 iframe 运行环境、原 Memory Books；会话响应延后、取消待打开、直接进入、3 条真实测试消息、选择第 2–3 条的原插件标记；未调用生成。
- `py -3.13 tools/verify_chat_runtime.py` 及 `--dark`：真实运行时的消息菜单、隐藏、回溯、编辑、多选、模型、Mod、记忆范围及其他相邻回归。该完整套件在本轮英文/滚动补修前通过；补修后重跑宿主页套件及安装包套件。
- `py -3.13 tools/verify_loading_r14.py`：Mod 请求挂起不拖住聊天，取消未就绪记忆后不会晚弹。
- `gradlew.bat testDebugUnitTest lintDebug assembleDebug -PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview -PHOMER_DEBUG_VERSION_CODE=293`：最终构建通过。
- `py -3.13 tools/verify_apk_assets.py`：1173 个条目，166 个前端文件，缺失 0。
- `node tools/verify_android_r22.cjs`：API 35 模拟器安装最终 APK，实际内置 UI 和运行时、触摸、键盘、原生返回；管理员/普通用户、搜索三态、真实记忆范围和中文按钮、无嵌套滚动。使用合成账号和隔离服务，未操作用户线上数据。

证据：`output/ui-r22/ui-results.json`、`memory-host-results.json`、`android/results.json` 和同目录截图。

## 性能边界（不能混为一谈）

原运行环境已就绪后，桌面浏览器内部点击到记忆布局约 21–27ms。最新宿主页测试从释放会话响应开始，包含整个运行环境初始化，约 1.26–1.61 秒；取消后重新点击的自动化流程约 221ms。Android 自动化触摸到检测出真实记忆控件约 1187ms，包含调试通信、轮询和界面处理，不等于纯绘制时间。

本轮解决重复入口、错误消息来源和阻断下一步的回归，**没有证明所有冷启动/网络连接等待消失**。真实账号的服务器权限与线上响应速度未通过合成测试替代验证。没有请求付费生成，因此不宣称已完成实际模型生成验收。

网页增量补丁 `web-patches/20260919-ui-r22-admin-search-memory.patch` 接在 R21 后，通过独立 Git index 验证；未更改原有暂存区。无需用户手动应用补丁才能安装此 APK。
