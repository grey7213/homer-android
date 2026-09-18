# 社区宿主接入补丁

本目录把仓库根 `server-extensions/` 中的社区领域服务接入现有惑梦后端宿主。它不是独立服务器，也不会创建第二套账号系统。

## 应用顺序

1. 备份生产 SQLite 数据库与当前后端源码。
2. 将以下文件复制到后端 `tools/`：
   - `server-extensions/community_feed.py`
   - `server-extensions/community_service.py`
   - `server-extensions/community_policy.py`
   - `server-extensions/community_media.py`
3. 在后端源码根应用 `integration.patch`。
4. 先在隔离数据库运行：

   ```powershell
   py -3.13 -m unittest -v tools/test_community_host_integration.py
   ```

5. 重启后端后，用普通账号和管理员账号分别验证 `/console/api/web/social/bootstrap`；确认普通账号不能访问 `admin/*`，再开放客户端入口。

## 接入内容

- 初始化可重复执行的 `social_*` 表，不改动账号、角色卡、积分和会话表。
- 复用宿主已认证用户、管理员权限和现有扩展响应协议。
- 把帖子中的 `ID：1234` 解析为当前用户有权查看的角色卡名称，只返回详情跳转所需的内部 ID 与名称。
- 媒体存储在受保护目录，通过鉴权路由读取，支持 Range；响应使用 `private, no-store` 和 `nosniff`。
- 保留既有 `/console/api/web/community/*` 创作赛事/资源接口，新社区使用 `/console/api/web/social/*`，互不覆盖。

## 回退

发生问题时先撤下 `social` 路由和客户端入口，再恢复备份的宿主文件。新增表可留存以便后续恢复，回退不需要删除用户社区数据。
