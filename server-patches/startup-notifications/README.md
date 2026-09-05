# 服务端启动通知配套更新

Android 仓库不含业务服务器主源码，因此此目录随客户端 PR 交付服务端改动。仅合并 Android PR 不会自动部署这些接口。

## 部署顺序

1. 备份业务服务代码与 SQLite 数据库。将本目录 `tools/` 下文件复制到业务服务器项目的 `tools/`，与 `ai_fengyue_local_server.py` 放在一起。
2. 在业务项目根目录运行 `git apply --check <此目录>/integration.patch`。检查通过后运行 `git apply <此目录>/integration.patch`；若上下文冲突，先人工合并，不要强行整文件覆盖。
3. 运行 `python tools/_selftest_notifications.py`。该测试使用临时数据库，不操作用户数据库。
4. 按当前服务的既有流程重启业务服务。启动时自动创建 `startup_notifications` 表，不改动用户、积分或会话表。
5. 再发布本 PR 的网页补丁及 APK。管理员在“通知管理”中创建一条通知验收，确认普通用户没有写入权限。

服务端补丁的本地源基线为 AIXingYue-main 当前主程序；没有将包含部署设置的整个主程序上传到公开仓库。

## 接口

- `GET /console/api/public/notifications`：公开已启用通知，按创建时间倒序。
- `GET /admin/api/notifications`：管理员获取全部通知。
- `POST /admin/api/notifications`：创建 `{title, content, enabled}`。
- `PUT /admin/api/notifications/{id}`：更新完整标题、正文、启用状态。
- `DELETE /admin/api/notifications/{id}`：删除通知。

写操作沿用服务器 token 管理员校验、请求处理与事务锁。普通用户写入被拒绝；通知最多 100 条，标题 80 字符，正文 10000 字符，只作为纯文本展示。

## 弹窗规则

一次进入软件只展示一次，栏目切换不重复；返回前台重新进入时可以再次展示。点击“今日不再弹出”后，本设备当前账号当天不再弹出，次日进入恢复。日期使用设备当地日期，新通知也遵守当天免打扰。该选项不是关闭系统通知权限，不做后台推送。

用户选择只保存在本设备，不会同步到其他设备。清理应用数据会清除此选择。离线或通知接口尚未部署时不显示弹窗，原页面和聊天不受阻塞；不会回放已删除通知的旧内容。

## 浏览器复验

需要 Python Playwright 及 Chrome。复制测试到服务端 tools 后，在该项目根目录运行 `python tools/verify_notifications.py`。它使用真实前端、真实通知路由及临时数据库，模拟其他业务 API，不联系生产服务器。要测另外一份前端，设置 `HOMER_TEST_WEB_ROOT` 指向其 frontend。
