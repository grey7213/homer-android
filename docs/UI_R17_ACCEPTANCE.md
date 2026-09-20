# R17 对话设置链路交付

日期：2026-09-19。源码：C:/CodexWork/homer-community-r9。

APK：D:/网站/惑梦-会话控制台R17-288-debug-20260919.apk

文件大小：48,260,132 字节。Debug 独立包名 org.nebula.horizon.composeai.uireview，versionCode 288。不覆盖正式签名版本；未提交、推送、部署或更改生产账户数据。

## 本轮改动

- 将右侧窄抽屉重组为底部会话控制面板，移动原按钮节点，保留权限及处理器。
- 模型设置先显示参数概览，逐项展开调整；无效数值阻止保存，取消不保存。
- 长记忆以整理任务为首页，保存设置和高级设置进入子页，返回先退回整理首页。
- 外观编辑提供实时样张及角色气泡、用户气泡、背景三个编辑目标。
- Mod 增加搜索、已启用筛选及无结果反馈，保留原读取失败/取消/排序行为。
- 保留会话作用域、卡片自有 HTML、用户已保存配色，以及用户此前指定删除的功能入口。

## 验证证据

- `py -3.13 tools/verify_chat_runtime.py`：390×844、1440×900 浅色回归通过。
- `py -3.13 tools/verify_chat_runtime.py --dark`：360×780、1440×900 深色回归通过；无页面异常和非预期网络失败。包含长按/编辑/回溯、多选、设置打开关闭、Mod 筛选取消、外观草稿取消及记忆实际范围。
- `node tools/verify_settings_android_r16.cjs`：Android 35 已安装包的缓存界面通过控制面板可见性、模型页、键盘下保存可见及原生返回检查。首次控制面板截屏未呈现打开状态，不能作为成功证据；已新增矩形/可见性断言，重跑并人工核对最终截图。输出 output/ui-r17/android，无异常或后端写入。
- `gradlew.bat testDebugUnitTest lintDebug assembleDebug -PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview -PHOMER_DEBUG_VERSION_CODE=288`：成功。
- `py -3.13 tools/verify_apk_assets.py`：1158 项清单，151 个前端文件，缺失 0。

## 补丁与限制

web-patches/20260919-ui-r17-control-center.patch 为 R15 后的 R16+R17 增量。依次应用已有 R10、R11、R12、R13、R14、R15 后应用该补丁。临时 index 的 apply --cached --check 通过，未改变真实暂存区。原生源码改动保留在主仓库工作区。

Android 安装验证中的账户与接口为明确隔离的测试数据；没有进行付费生成或真实服务器写入。完整运行时设置链路使用浏览器 E2E 验证，不能表述为所有插件均已在真机完成真实生成测试。本轮交付只针对会话控制面板和设置链路，未宣称全部软件页面重新设计完成，也未将技术通过视为用户视觉认可。
