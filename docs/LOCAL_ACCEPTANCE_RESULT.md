# 本机服务器验收包 294

本轮未提交、推送、上传或部署。用户验收认可后才允许进入提交阶段。

## 实际环境

- 当前客户端：`C:/CodexWork/homer-community-r9`，保留 R9—R22 累计改动。
- 本机后端/独立测试数据库：`D:/网站/功能/AIXingYue-main/output/offline-dev`，未重置数据库或密码。
- 当前客户端前端和运行时直接供本机代理使用，没有用旧版前端覆盖新成果。
- APK：`D:/网站/惑梦-本机服务器验收-294-debug.apk`；包名 `.uireview`，版本代码 294，Debug 签名，不覆盖正式签名应用。
- 连接 `http://172.24.5.154:8080/`，手机需能访问电脑所在局域网。电脑关机、服务停止或 WLAN 地址变化后不可继续使用这一固定地址；不是在线正式版。
- 重启服务：`D:/网站/启动惑梦本地验收.ps1`。不改生产 HTTPS 地址配置，不开放内部数据库或运行时端口到局域网。

## 本轮修复与真实验证

- 恢复既有本地服务，管理员身份由原后端确认。之前提供的本地测试账号可用，没有从浏览器缓存伪造管理员，没有写入凭据到源码/报告。
- 修复社区在私有网络 HTTP 下调用 `crypto.randomUUID` 导致初始化失败的问题。使用 `crypto.getRandomValues` 生成 v4 操作 ID，发布、编辑和媒体路径共用。
- `py -3.13 tools/verify_local_acceptance.py ...`：真实密码登录、退出再登录、后台鉴权；390×844 与 1440×900 的社区、探索、创作、历史、我的页面返回 200，无脚本和 HTTP 错误。页面网络稳定等待约 0.56—0.62 秒（含 Playwright 500ms 静默等待，不是首帧指标）。
- `node tools/verify_local_android.cjs`：API 35 安装 APK，直接访问电脑 API，无接口拦截。实际退出/重登、后台权限、管理页面、原历史会话与真实 Memory Books 均通过。
- Android 截图已检查：我的页显示管理后台；长记忆显示当前会话的真实消息范围，不再是“当前会话还未连接”的替身入口。未调用付费生成。
- Gradle `testDebugUnitTest lintDebug assembleDebug -PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview -PHOMER_DEBUG_VERSION_CODE=294 -PHOMER_DEBUG_SERVER_BASE_URL=http://172.24.5.154:8080/` 通过。一次缺少 ANDROID_HOME 的重跑失败，补回既有 SDK 环境后通过。
- `py -3.13 tools/verify_apk_assets.py`：1174 项资源，167 个前端文件缺失 0。新包已安装到测试模拟器。

## 仍存在的差距

- 两次 Android 真实会话运行时完整就绪为 5.50/4.53 秒，已就绪后的长记忆入口为 1.27/0.68 秒（包括触摸自动化等待）。本轮不宣称达到秒开，更不能把浏览器模拟 API 的结果当作此耗时。
- 旧测试卡一处封面仍保存为回环地址 `127.0.0.1:8080/media-cache/...`，手机访问失败。未批量改写旧卡或历史数据；核心账号/API 不使用该回环地址。
- 本轮恢复的是本机真实服务，未验证生产服务器。模型生成、创作收益结算补丁、全部社区业务不属于本轮已完成的验收证明。

证据位于忽略目录 `output/local-acceptance/`，无登录密码或会话令牌。
