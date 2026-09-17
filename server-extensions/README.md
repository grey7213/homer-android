# 社区服务端接入

本目录是新增社区所需的服务端源码，不在 Android 中执行，也尚未部署线上。客户端沿用现有登录 Cookie/Token，不接受客户端传来的用户身份作为鉴权依据。

将本目录的 `community_feed.py`、`community_service.py`、`community_policy.py`、`community_media.py` 一同放入现有服务器的扩展目录，保持可相互导入。在数据库初始化位置调用 `ensure_feed_schema(self.conn, self.lock)`。迁移只新增或更新 `social_*` 表，保留旧帖子、评论、举报；不修改用户、积分、角色卡或会话表。生产执行迁移前先备份数据库。

在现有 `handle_community_route` 同级分发处（既有身份认证之后）添加 `console/api/web/social/` 路由，传入相同的 `conn`、`lock`、经服务端认证的 `user` 与 `is_admin`：

```python
from community_feed import ensure_feed_schema, handle_feed_route

# 身份来自服务器现有验证流程；保留现有 CSRF / Origin 检查。
return extension_response(handle_feed_route(method, normalized, query, body, ctx))
```

`extension_response` 按已有扩展协议处理 `__http__` 状态码。此分发仅用于 social 前缀，其他请求继续原路由。反向代理需允许 PUT/PATCH/DELETE；鉴权、CSRF、图片上传大小限制沿用现有服务，部署前验证未登录和跨站写入均被拒绝。

R5 接口包含 bootstrap/policy/consent、帖子、评论与楼中回复、关注/双向拉黑、账号状态/申诉、互动通知、搜索、浏览记录和 admin 下的举报、巡查、禁言、审核、规则、公告、日志、统计。非管理员请求 admin/* 始终拒绝。reports 对普通账号只返回本人举报；管理员完整队列使用 admin/reports。

R8 按产品要求公开社区：首次初始化 `mode=open`；已有库在首次 R8 初始化时将 `internal` 迁移为 `open` 并写入 `r8_public_launch` 标记。明确设置为 `closed` 的库不自动重开；迁移完成后管理员主动关闭或改回内部测试也不会被重启覆盖。部署前备份数据库，部署后确认“社区管理 → 开放设置”为公开。普通登录账号仍须同意协议，禁言、审核、拉黑和管理权限保持有效；不识别 preview=1。原有赛事接口应复用同样的准入检查。

客户端“我的”设置、原有投稿、收藏和通知中心承接新增内容，没有新的社区个人中心。帖子列表使用当前排序的快照游标，单次快照最多最近 2000 篇；热门在此窗口内按互动和时间衰减排序，15 分钟后刷新。浏览记录最多 200 篇；评论根列表每页 20 条，楼中回复每页 10 条。

关键词库由后台管理，当前预置 3 条明确诈骗/隐私/广告样例，默认转人工审核；不是完整商业审核库。类别不包含“色情低俗”，旧库中不在当前类别表的规则自动停用。链接、媒体和短时重复文本自动进入待审核；管理员按上下文决定，不按举报数量自动封禁。可选 ctx['review_content'] 回调返回 published/pending/rejected；未接入该回调不代表已经具备语义/图像智能审核。

## 角色卡名称解析（宿主必须接入）

传入 `ctx['resolve_cards'] = resolve_cards`。输入为最多 20 个用户输入的展示 ID 和宿主认证的 user；返回：

```python
def resolve_cards(public_ids, user):
    # 从现有角色查询/授权服务读取，不直接扫描客户端卡片缓存。
    # 仅返回该用户有权看到且可进入详情的角色；不返回源文件、世界书或预设。
    return {
        public_id: {'id': card.internal_id, 'name': card.name, 'visible': True}
        for public_id, card in existing_visible_card_lookup(public_ids, user).items()
    }
```

`existing_visible_card_lookup` 表示宿主现有服务，不能原样当作已实现函数复制。未接入时客户端保留 ID 文本并提示暂不可查看，不编造角色名。

## 媒体服务（可选，视频需要）

图片继续调用原有 upload-cover，沿用其身份、尺寸、文件内容验证。新增视频使用分片上传，MP4 最大 100 MB、每片 512 KB、每账号每日累计 300 MB，待审核时不公开。

```python
from community_media import CommunityMediaStore

# 仅服务初始化时调用，不要每请求创建；directory 位于受保护的媒体目录。
media_store = CommunityMediaStore(conn, lock, directory)
# 每次经过宿主认证后的请求：
ctx['media_store'] = media_store
```

宿主需增加 `GET /console/api/web/social-media/<id>` 的流式响应：先完成既有认证，再调用 `media_store.read_file(id, ctx)` 获得内部路径和 MIME。只允许返回文件内容，**不能将绝对路径序列化为 JSON**；配置 `Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`，支持标准 Range 请求以便视频拖动。媒体路径不可直接由静态服务器公开，否则会绕开审核/双向拉黑检查。

本模块只做类型头、分片次序、大小、所有权与访问验证，不做视频转码、恶意文件深度扫描或自动图片识别。生产媒体管线应接入已有转码/扫描服务；没有配置 media_store 时客户端明确禁用视频上传。未完成上传保留在专属目录，运维需按数据库 upload 状态定期清理过期孤立文件；不要对混合业务目录做递归删除。

所有写接口必须保留宿主既有 CSRF/Origin 验证与总请求体大小限制（分片 JSON 建议 1 MB）；不能用客户端传入的角色、user_id 或 is_admin 作为身份。社区禁言仅限制社区互动，不限制 AI 对话和账号其他功能。当前没有新增用户私信；后续若接入私信，需同样调用双向拉黑判断。

验证：在仓库根执行 `py -3.13 tools/test_community_r5.py`（包含基础用例）和 `py -3.13 tools/verify_community_feed.py`。测试使用独立内存数据库、临时媒体目录和合成账号，不接触线上数据。Android 检查使用 `tools/verify_community_android.cjs` 和本地测试服务器，仅可运行在已退出账号的 `.uireview` 验收包中。
