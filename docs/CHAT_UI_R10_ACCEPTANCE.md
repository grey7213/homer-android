# 对话 UI R10 本地验收

日期：2026-09-18。源码：C:\CodexWork\homer-community-r9。

## 交付

- APK：D:\网站\惑梦-对话UI-R10-debug-20260918.apk
- 包名：org.nebula.horizon.composeai.uireview。Debug 验收包，不替换正式签名应用。
- 未提交、推送或部署；真实账号会话未发送、生成或修改消息。
- Web 增量补丁：web-patches/20260918-1930-chat-ui-r10-incremental.patch。依赖此前的 20260918-1001-community-r9-complete-server-backed.patch，须先 R9 后 R10；不能作为独立全量补丁使用。

## 修改

- 修复移动端 top:auto!important 覆盖消息菜单定位的根因。菜单按消息、触点及可用视口定位，尺寸变化重新限位，滚动关闭。
- 消息普通文字长按不再同时触发 Android 原生文字选择；输入、编辑等可交互内容保留选择能力。
- 顶栏维持透明、隐藏角色名，滚动正文避让顶部操作区域；不恢复收藏、重启和右下续写。
- 设置入口改明确齿轮图标；抽屉说明允许换行；模型参数及底部操作收紧排版。
- 记忆跳转按钮增加“未整理记忆”标识，按实际尺寸限制在视口内，保留原拖动与点击逻辑。

## 验证证据

- `py -3.13 tools/verify_chat_runtime.py`：390×844、1440×900 通过；结果在 output/ui-rework-r2/runtime/results.json。包含菜单位置、无原生选择、隐藏、折叠、多选、编辑、回溯、取消、模型与记忆入口等。控制台和请求检查无错误。初次断言捕获定位覆盖问题，修复后通过；新配置下记忆扩展异步加载曾导致测试提前点击，改为等待真实入口后通过。
- `gradlew.bat testDebugUnitTest lintDebug assembleDebug -PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview`：成功。
- `py -3.13 tools/verify_apk_assets.py`：通过，1147 项清单、141 个前端文件，缺失 0，APK 约 45.5 MB。
- `node --check frontend/assets/js/memory-ui.js`：通过。
- 增量补丁反向检查及相对现有 R9 暂存基线的应用检查通过；保留原有 R9 暂存改动。
- MuMu Android：升级安装成功、登录保留、真实历史会话打开，最终菜单及模型弹窗截图已检查。截图在 output/chat-ui-r10/android-longpress-final.png、android-model.png、android-chat.png。
- 最终记忆按钮边界调整经模拟器验证；完整双视口回归运行于该小调整之前，最终构建和资源校验包含该调整。

## 验证边界

使用模拟器，未验证用户实体手机的全部系统、字体与键盘组合；未进行真实模型生成。本次没有宣称完成 TAVO 全界面像素级还原。测试临时修改的模拟器分辨率、旋转设置已恢复。
