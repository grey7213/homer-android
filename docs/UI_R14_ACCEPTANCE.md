# R14 紧凑界面与工具打开链路

源码：`C:/CodexWork/homer-community-r9`；web 文件来自 `.web-cache/tree` 的 junction。本轮仅本地修改和 Debug 交付，未 commit/push/部署。

## 用户最终要求

最后纠正“配色还是改回原来的吧，其他继续”：取消图三三色主题，恢复上一版配色和默认气泡色；保存/确定按钮不恢复渐变。用户保存的会话配色和卡片自有 HTML 不覆盖。

- 删除重复的核心编辑页，直接进入基础设置。五个顶部分区始终可切换，导入/导出/预览仍在操作菜单。
- 角色编辑、普通表单、管理列表和工具窗口收紧；保留手机触控区域与底部保存键。窄屏发布开关改为纵向行，避免分字换行。
- 左侧创意工坊不拆行，导航和历史文本统一字体。右抽屉恢复单行“功能名—摘要—箭头”，模型、Mod、记忆、外观等配套窗口同步调整；保留已删除的标题/收藏/重启/续写约束，不恢复这些入口。
- 普通气泡正文 15px、行高 1.45，段间距和气泡间距收紧；卡片 iframe 不强行覆盖。

## 为什么长记忆/Mod 打开慢

1. 宿主壳可以先显示缓存，但工具命令原来必须排队等待完整运行时就绪，期间无操作反馈。现在准备窗口可取消，取消后不再延迟打开。
2. `loadRuntimeUiData()` 原来将模型列表、Mod 库、会话 Mod 放入同一个必等 Promise，Mod 慢请求阻塞整个对话启动。现拆分：Mod 独立读取，错误可重试；未知状态禁止保存，不冒充空库。跨会话旧响应被丢弃。
3. Memory Books 菜单在监听器安装前就出现；旧桥接每 180ms 轮询，最多 30 秒。改为就绪事件和可取消请求。打开设置原来还编译选中消息并计算 token；现设置页只读取范围，实际生成/预览仍走完整计算与校验。
4. Memory Books 实际加载 `index.build.js`，不是源码 `index.js`。已通过 Bun 1.4.2 按插件 build.ts 重建，保留版权与许可证；构建专用 node_modules 不入 APK。

## 验证

- `py -3.13 tools/verify_ui_r14.py`：393×762、360×780、1440×900；五标签、字段保留、纯色保存、导入选择器、角色搜索/筛选、删除取消、版本窗口返回、工坊入口通过。
- `py -3.13 tools/verify_chat_runtime.py`：390×844、1440×900；真实隔离运行时模型/Mod/记忆、长按、隐藏、编辑、回溯、多选、弹窗返回、外观保存/取消、透明顶栏通过；页面异常与意外失败请求为 0。
- `py -3.13 tools/verify_loading_r14.py`：360×780、1440×900；两个 Mod 请求保持未返回时对话先就绪；等待中禁保存，关闭后不重弹；记忆就绪前取消有效；正文 15px/21.75px。
- `py -3.13 tools/verify_models_r12.py`：120 项管理模型批量、123 项公共目录/3 分组、取消和保存失败保留草稿通过。
- `py -3.13 tools/verify_community_r7.py`：三个尺寸、八个独立页面及普通用户/正式包权限隔离通过。
- `py -3.13 tools/verify_ux_r11.py`：普通用户与管理员、纯净区定义、导入和管理入口通过。
- `py -3.13 tools/verify_delivery_r13.py`：12 个页面×3 个尺寸、深色设置、资源窗口、兑换禁用、数据合并和读取失败重试通过。
- Gradle：`testDebugUnitTest lintDebug assembleDebug -PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview -PHOMER_DEBUG_VERSION_CODE=285` 成功，38 项单测无失败。
- `py -3.13 tools/verify_apk_assets.py`：1154 项清单，147 个前端文件缺失 0。
- Android 35 最终 285 装机：`HOMER_TEST_DEVICE=emulator-5556 HOMER_CDP_PORT=18224 HOMER_REQUIRE_IME=1 node tools/verify_community_r7_android.cjs` 通过；真实 Gboard、输入区边界、角色保存键、原生返回、草稿和系统文件选择通过，页面异常 0、远程写入 0。修复测试捕获的安全区脚本在文档尚未生成时访问 null 的竞态。

## 交付

APK：`D:/网站/惑梦-紧凑界面R14-285-debug-20260919.apk`。

包名 `org.nebula.horizon.composeai.uireview`，versionCode 285，versionName `1.15.2-debug`，48,179,907 字节，沿用 `https://patcher.villainy.top/`。Debug 签名，可更新之前同签名验收包，不覆盖正式签名版。

补丁 `web-patches/20260919-ui-r14-compact-tools.patch` 接在 R9→R10→R11→R12→R13 后；临时 index 的 apply --cached --check 通过，未动真实 web 暂存区。

限制：未在用户物理手机与生产账号下测得每次打开的耗时，不能保证所有冷启动瞬时完成；原版所有设置界面没有同状态像素基准，本次不能宣称 Tavo 全功能/全页面 1:1。参照规格来自已有 `TAVO_150_R12_SPEC.md`，不复制第三方闭源代码或图片。现有业务权限、账号同步与服务器配置未变。
