# 社区 R8：公开入口与默认首页验收

## 结果

- Android 新启动目标、`/app/` 根入口和登录默认回跳统一为 `/app/community.html`。
- 底部导航固定显示“社区”，普通账号无需管理员身份即可访问；debug 本机验收模式仍须显式进入，线上入口不会自动使用本机数据。
- 新社区数据库默认 `open`；旧 `internal` 配置仅自动迁移一次，之后管理员明确设置的 `internal` 或 `closed` 均保留。
- 首次进入仍强制同意社区协议；未登录、禁言、审核和管理员权限规则未放宽。

## 验证

1. `py -3.13 -m unittest discover -s tools -p 'test_community*.py'`：63 项通过。
2. `py -3.13 tools/verify_community_public.py`：390×844、360×800、1440×900 通过；普通账号默认进入社区、协议、发布、角色卡 ID 解析均通过，无控制台错误和失败请求。
3. `py -3.13 tools/verify_community_r7.py`：三视口独立页面、本机隔离、权限和零线上写入通过。
4. `gradlew.bat --no-daemon testDebugUnitTest lintDebug assembleDebug -PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview`：通过。
5. `py -3.13 tools/verify_apk_assets.py`：1146 项资源，140 个前端文件，缺失 0。
6. `node tools/verify_community_r7_android.cjs`：安装包中的独立页面、Android 返回、草稿、评论、发布、文件选择器与本机管理通过。

## 发布边界

本提交包含客户端、社区服务扩展和集成说明，但不会自动部署生产服务器。维护者合并后仍须依照 `server-extensions/README.md` 将真实社区路由接入现有鉴权、CSRF 和数据库事务，再由正式签名流程发布 APK。MuMu 输入法未实际缩小视口，真实手机的软键盘遮挡仍需复核。
