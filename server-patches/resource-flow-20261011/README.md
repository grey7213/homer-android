# 创作资源软删除增量修复

仅修复服务端已经 `status='deleted'` 的资源仍出现在本人列表、可读取详情／历史版本、可继续更新／收藏的问题。客户端兼容过滤不会隐藏服务器尚未确认删除的资源。

`backend.patch` 对应 `tools/community_workshop.py` 的四处窄边界，`manifest.json` 记录 LF 输入／结果摘要。执行导出脚本不会修改或部署输入源码；维护者先核对当前服务端摘要，再在副本执行 `git apply --check`，审阅后部署。对不同代码不能硬套或整目录覆盖。

本包不迁移数据库、不抹掉已有角色卡绑定的资源快照、不删除用户角色卡，也不部署农场统一积分服务。农场仍必须具备既有 `account_balance` + `profile.points==profile.coins` 合同以及服务端原子收获、幂等事务。
