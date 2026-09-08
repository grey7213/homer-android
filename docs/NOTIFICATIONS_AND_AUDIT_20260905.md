# 启动通知与本地交互修复

## 问题

缺少管理员可维护的启动通知。此前本地排查发现跨存档整页重载、异步状态串会话、草稿丢失及账号缓存隔离问题，需要与通知一起提交。

## 影响

用户无法在进入应用时接收站内通知；切换历史会话时可能出现额外等待或旧状态覆盖。本轮不改变已有 UI 布局、模型接口、积分规则和角色卡能力。

## 修复

- 后台新增“通知管理”：创建、编辑、删除、启用/停用，沿用管理员权限。
- 进入应用非阻塞获取通知，正文仅显示纯文本；支持“我知道了”和“今日不再弹出”。免打扰按本设备账号及当地日期保存，次日恢复；栏目切换不重复弹出。
- 合并此前本地会话切换、异步状态/待发指令归属、草稿恢复、账号缓存隔离、数据库摘要及流式解析修复。
- 基于上游 `c46c7a0` 与 web-base `b0225ab462945bc3bd9c8537e19e19f932b17a3d` 三方合并，保留上游原生桥接收者、历史头像标题回退等修改。未降级 1.14.4 / 269。
- 修复 Windows 补丁导出时 stderr 警告混进 diff 的问题，增加 2 项回归测试。

网页补丁位于 `web-patches/`，业务服务器改动及部署说明位于 `server-patches/startup-notifications/`。服务器主源码不在本仓库，不做整文件覆盖。

## 验证

2026-09-05 本机执行并通过：

| 命令/检查 | 结果 |
| --- | --- |
| `python tools/test_export_web_patch.py` | 2 项通过；导出补丁在干净固定基线上 `git apply --check --index` 及实际应用通过 |
| 后端 `python tools/_selftest_notifications.py` | 真实路由、临时数据库：增删改/停用、权限拒绝、字段校验、缺失记录、公开接口只读通过 |
| 后端 `python tools/verify_notifications.py`，HOMER_TEST_WEB_ROOT 指向本工作区 frontend | 1440×900、390×844：弹窗、纯文本、当日抑制/次日恢复、后台 CRUD 通过；无控制台错误/请求失败/横向溢出 |
| `python tools/verify_local_audit.py` | 两视口会话/缓存/草稿/SSE/注销回归通过，缓存首帧约 216ms / 109ms；模拟 API 和运行时消息，不代表生产完整加载速度 |
| Gradle `testDebugUnitTest lintDebug assembleDebug connectedDebugAndroidTest`，调试后缀 `.audit` | 18 项单元测试、MuMu Android 12 上 5 项数据库测试通过；构建成功，Lint 无 error |
| `python tools/verify_apk_assets.py` | 清单 1116 项，110 个前端文件无缺失，运行时 lib 约 1902KB |
| 安装 audit APK 并冷启动 | 启动成功，Activity 1081ms；非完整对话 ready 时间 |
| `node tools/verify_android_audit.cjs`，转发 audit WebView CDP 到 18222 | 实际 Java 桥访问轮次 ID、保留 receiver、摘要读取、账号隔离通过，无横向溢出 |

设备测试独立包名 `org.nebula.horizon.composeai.audit`，未覆盖或卸载正式应用。没有登录生产账号做真实模型生成验收；通知 CRUD 使用隔离数据。浏览器截图已检查，测试产物保存在本机 output，不提交用户数据或 APK。

## 发布边界

先部署业务服务器补丁，再发布配套网页资源和 APK。既有热更新槽优先于 APK 内资源，维护者必须同步更新槽版本，不能仅更换 APK。PR 创建不等于服务器或官网已更新，正式签名由维护者完成。

离线或通知 API 未部署时跳过通知，不阻断进入应用。今日免打扰不跨设备同步；清理应用数据后会丢失。未缓存历史、复杂角色脚本初始化及模型生成仍需要实际网络与设备验收，不能用本机缓存首帧时间替代。
